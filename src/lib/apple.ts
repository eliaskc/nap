import { Effect, Schema } from "effect";
import { importPKCS8, SignJWT } from "jose";
import { napConfig } from "~/nap.config";
import { Settings } from "~/server/platform";
import { Storage, tryStorage } from "~/server/storage";

/**
 * Apple's side of apps: the App Store Connect API and the ad hoc provisioning profile.
 *
 * Nap signs with one Apple Distribution certificate and one ad hoc profile for a wildcard App ID
 * (<bundleIdPrefix>.*). The profile lists the devices that may install. Nap reads it by name
 * through the App Store Connect API and keeps a copy in R2, so signing does not call Apple.
 */

const PROFILE_KEY = "apps/_signing/adhoc.mobileprovision";
const API = "https://api.appstoreconnect.apple.com/v1";

export class AppleError extends Schema.TaggedError<AppleError>()("AppleError", {
  message: Schema.String,
}) {}

/** A 10-minute App Store Connect token, signed with the team API key. */
const apiToken = Effect.fnUntraced(function* () {
  const { appStoreConnect: ascKey } = yield* Settings;
  if (!ascKey) {
    return yield* new AppleError({ message: "The App Store Connect key is not set up" });
  }
  const { keyId: kid, issuerId: iss, privateKey: pem } = ascKey;
  // A bad key or a failed signature is a defect, like any other unexpected failure.
  return yield* Effect.promise(async () => {
    const key = await importPKCS8(pem.replace(/\\n/g, "\n"), "ES256");
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
      .setIssuer(iss)
      .setIssuedAt()
      .setExpirationTime("10m")
      .setAudience("appstoreconnect-v1")
      .sign(key);
  });
});

export const appStoreConnect = Effect.fn("appStoreConnect")(function* <T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const token = yield* apiToken();
  const response = yield* Effect.promise(() =>
    fetch(`${API}/${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
  if (response.status === 204) return {} as T;
  const data = (yield* Effect.promise(() => response.json().catch(() => ({})))) as {
    errors?: Array<{ detail?: string; title?: string }>;
  };
  if (!response.ok) {
    const error = data.errors?.[0];
    return yield* new AppleError({
      message: `App Store Connect: ${error?.detail ?? error?.title ?? response.statusText}`,
    });
  }
  return data as T;
});

type ProfileList = {
  data: Array<{
    id: string;
    attributes: { name: string; profileContent: string; profileState: string };
  }>;
};

export type SigningProfile = { id: string; bytes: Uint8Array };

const profileName = Effect.suspend(() =>
  napConfig.apps
    ? Effect.succeed(napConfig.apps.profileName)
    : Effect.fail(new AppleError({ message: "Apps are off on this Nap" })),
);

/** The active ad hoc profile with Nap's profile name, from Apple. */
const currentProfile = Effect.fnUntraced(function* () {
  const name = yield* profileName;
  const list = yield* appStoreConnect<ProfileList>(
    `profiles?filter[name]=${encodeURIComponent(name)}&filter[profileType]=IOS_APP_ADHOC&limit=10`,
  );
  return (
    list.data.find(
      (item) => item.attributes.name === name && item.attributes.profileState === "ACTIVE",
    ) ?? null
  );
});

const storeProfile = Effect.fnUntraced(function* (id: string, content: string) {
  const storage = yield* Storage;
  const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  yield* storage.put(PROFILE_KEY, bytes, {
    customMetadata: { profileId: id, fetchedAt: new Date().toISOString() },
  });
  const profile: SigningProfile = { id, bytes };
  return profile;
});

/** Fetches the ad hoc profile from Apple by name and stores it in R2. */
export const refreshProfile = Effect.fn("refreshProfile")(function* () {
  const profile = yield* currentProfile();
  if (!profile) {
    return yield* new AppleError({
      message: `No active ad hoc profile named "${yield* profileName}"`,
    });
  }
  return yield* storeProfile(profile.id, profile.attributes.profileContent);
});

/** How long the copy in R2 is trusted before Nap asks Apple again. */
const PROFILE_TTL_MS = 60 * 60 * 1000;

/**
 * The profile to sign with: the copy in R2 when it is under an hour old, else Apple's. If Apple
 * cannot be reached, the copy is still used.
 */
export const signingProfile = Effect.fn("signingProfile")(function* () {
  const storage = yield* Storage;
  const stored = yield* storage.get(PROFILE_KEY);
  const id = stored?.customMetadata?.profileId;
  const fetchedAt = Date.parse(stored?.customMetadata?.fetchedAt ?? "");
  if (stored && id) {
    const copy: SigningProfile = {
      id,
      bytes: new Uint8Array(yield* tryStorage(() => stored.arrayBuffer())),
    };
    if (Date.now() - fetchedAt < PROFILE_TTL_MS) return copy;
    // Any failure, expected or not, falls back to the copy.
    return yield* refreshProfile().pipe(Effect.catchCause(() => Effect.succeed(copy)));
  }
  return yield* refreshProfile();
});

type DeviceList = {
  data: Array<{ id: string; attributes: { udid: string; status: string; name: string } }>;
};

/**
 * Registers an iPhone with the Apple team (or enables it again) and returns Apple's device id.
 * Apple counts each registration against the team's 100 iPhones a year.
 */
export const registerDevice = Effect.fn("registerDevice")(function* (udid: string, name: string) {
  const found = yield* appStoreConnect<DeviceList>(
    `devices?filter[udid]=${encodeURIComponent(udid)}&limit=5`,
  );
  const existing = found.data.find((device) => device.attributes.udid === udid);
  if (existing) {
    if (existing.attributes.status !== "ENABLED") {
      yield* appStoreConnect(`devices/${existing.id}`, {
        method: "PATCH",
        body: { data: { type: "devices", id: existing.id, attributes: { status: "ENABLED" } } },
      });
    }
    return existing.id;
  }
  const created = yield* appStoreConnect<{ data: { id: string } }>("devices", {
    method: "POST",
    body: {
      data: { type: "devices", attributes: { name: name.slice(0, 50), udid, platform: "IOS" } },
    },
  });
  return created.data.id;
});

/**
 * Replaces the ad hoc profile with one that lists every enabled iPhone of the team, for the same
 * App ID and certificate, and stores it. Apple profiles cannot be edited, so this deletes the old
 * one and creates one with the same name.
 */
export const regenerateProfile = Effect.fn("regenerateProfile")(function* () {
  const old = yield* currentProfile();
  if (!old) {
    return yield* new AppleError({
      message: `No active ad hoc profile named "${yield* profileName}"`,
    });
  }
  const [bundle, certificates, devices] = yield* Effect.all(
    [
      appStoreConnect<{ data: { id: string } }>(`profiles/${old.id}/bundleId`),
      appStoreConnect<{ data: Array<{ id: string }> }>(`profiles/${old.id}/certificates`),
      appStoreConnect<DeviceList>("devices?filter[status]=ENABLED&filter[platform]=IOS&limit=200"),
    ],
    { concurrency: "unbounded" },
  );
  yield* appStoreConnect(`profiles/${old.id}`, { method: "DELETE" });
  const created = yield* appStoreConnect<{ data: ProfileList["data"][number] }>("profiles", {
    method: "POST",
    body: {
      data: {
        type: "profiles",
        attributes: { name: yield* profileName, profileType: "IOS_APP_ADHOC" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundle.data.id } },
          certificates: {
            data: certificates.data.map((item) => ({ type: "certificates", id: item.id })),
          },
          devices: { data: devices.data.map((item) => ({ type: "devices", id: item.id })) },
        },
      },
    },
  });
  return yield* storeProfile(created.data.id, created.data.attributes.profileContent);
});

/** The bundle id of a target. Only called where apps are on (the apps API checks first). */
export function bundleIdFor(target: string) {
  return `${napConfig.apps?.bundleIdPrefix ?? "nap"}.${target}`;
}

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
