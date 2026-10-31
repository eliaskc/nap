import { importPKCS8, SignJWT } from "jose";
import { napConfig } from "~/nap.config";

/**
 * Apple's side of apps: the App Store Connect API and the ad hoc provisioning profile.
 *
 * Nap signs with one Apple Distribution certificate and one ad hoc profile for a wildcard App ID
 * (<bundleIdPrefix>.*). The profile lists the devices that may install. Nap reads it by name
 * through the App Store Connect API and keeps a copy in R2, so signing does not call Apple.
 */

export type AppleEnv = {
  SITES: R2Bucket;
  NAP_ASC_KEY_ID?: string;
  NAP_ASC_ISSUER_ID?: string;
  NAP_ASC_PRIVATE_KEY?: string;
};

const PROFILE_KEY = "apps/_signing/adhoc.mobileprovision";
const API = "https://api.appstoreconnect.apple.com/v1";

export class AppleError extends Error {}

/** A 10-minute App Store Connect token, signed with the team API key. */
async function apiToken(env: AppleEnv) {
  const { NAP_ASC_KEY_ID: kid, NAP_ASC_ISSUER_ID: iss, NAP_ASC_PRIVATE_KEY: pem } = env;
  if (!kid || !iss || !pem) throw new AppleError("The App Store Connect key is not set up");
  const key = await importPKCS8(pem.replace(/\\n/g, "\n"), "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
    .setIssuer(iss)
    .setIssuedAt()
    .setExpirationTime("10m")
    .setAudience("appstoreconnect-v1")
    .sign(key);
}

export async function appStoreConnect<T>(
  env: AppleEnv,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${API}/${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${await apiToken(env)}`,
      "content-type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (response.status === 204) return {} as T;
  const data = (await response.json().catch(() => ({}))) as {
    errors?: Array<{ detail?: string; title?: string }>;
  };
  if (!response.ok) {
    const error = data.errors?.[0];
    throw new AppleError(
      `App Store Connect: ${error?.detail ?? error?.title ?? response.statusText}`,
    );
  }
  return data as T;
}

type ProfileList = {
  data: Array<{
    id: string;
    attributes: { name: string; profileContent: string; profileState: string };
  }>;
};

export type SigningProfile = { id: string; bytes: Uint8Array };

function profileName() {
  const apps = napConfig.apps;
  if (!apps) throw new AppleError("Apps are off on this Nap");
  return apps.profileName;
}

/** The active ad hoc profile with Nap's profile name, from Apple. */
async function currentProfile(env: AppleEnv) {
  const name = profileName();
  const list = await appStoreConnect<ProfileList>(
    env,
    `profiles?filter[name]=${encodeURIComponent(name)}&filter[profileType]=IOS_APP_ADHOC&limit=10`,
  );
  return (
    list.data.find(
      (item) => item.attributes.name === name && item.attributes.profileState === "ACTIVE",
    ) ?? null
  );
}

async function storeProfile(env: AppleEnv, id: string, content: string): Promise<SigningProfile> {
  const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  await env.SITES.put(PROFILE_KEY, bytes, {
    customMetadata: { profileId: id, fetchedAt: new Date().toISOString() },
  });
  return { id, bytes };
}

/** Fetches the ad hoc profile from Apple by name and stores it in R2. */
export async function refreshProfile(env: AppleEnv) {
  const profile = await currentProfile(env);
  if (!profile) throw new AppleError(`No active ad hoc profile named "${profileName()}"`);
  return storeProfile(env, profile.id, profile.attributes.profileContent);
}

/** How long the copy in R2 is trusted before Nap asks Apple again. */
const PROFILE_TTL_MS = 60 * 60 * 1000;

/**
 * The profile to sign with: the copy in R2 when it is under an hour old, else Apple's. If Apple
 * cannot be reached, the copy is still used.
 */
export async function signingProfile(env: AppleEnv): Promise<SigningProfile> {
  const stored = await env.SITES.get(PROFILE_KEY);
  const id = stored?.customMetadata?.profileId;
  const fetchedAt = Date.parse(stored?.customMetadata?.fetchedAt ?? "");
  if (stored && id) {
    const copy = { id, bytes: new Uint8Array(await stored.arrayBuffer()) };
    if (Date.now() - fetchedAt < PROFILE_TTL_MS) return copy;
    return refreshProfile(env).catch(() => copy);
  }
  return refreshProfile(env);
}

type DeviceList = {
  data: Array<{ id: string; attributes: { udid: string; status: string; name: string } }>;
};

/**
 * Registers an iPhone with the Apple team (or enables it again) and returns Apple's device id.
 * Apple counts each registration against the team's 100 iPhones a year.
 */
export async function registerDevice(env: AppleEnv, udid: string, name: string) {
  const found = await appStoreConnect<DeviceList>(
    env,
    `devices?filter[udid]=${encodeURIComponent(udid)}&limit=5`,
  );
  const existing = found.data.find((device) => device.attributes.udid === udid);
  if (existing) {
    if (existing.attributes.status !== "ENABLED") {
      await appStoreConnect(env, `devices/${existing.id}`, {
        method: "PATCH",
        body: { data: { type: "devices", id: existing.id, attributes: { status: "ENABLED" } } },
      });
    }
    return existing.id;
  }
  const created = await appStoreConnect<{ data: { id: string } }>(env, "devices", {
    method: "POST",
    body: {
      data: { type: "devices", attributes: { name: name.slice(0, 50), udid, platform: "IOS" } },
    },
  });
  return created.data.id;
}

/**
 * Replaces the ad hoc profile with one that lists every enabled iPhone of the team, for the same
 * App ID and certificate, and stores it. Apple profiles cannot be edited, so this deletes the old
 * one and creates one with the same name.
 */
export async function regenerateProfile(env: AppleEnv): Promise<SigningProfile> {
  const old = await currentProfile(env);
  if (!old) throw new AppleError(`No active ad hoc profile named "${profileName()}"`);
  const [bundle, certificates, devices] = await Promise.all([
    appStoreConnect<{ data: { id: string } }>(env, `profiles/${old.id}/bundleId`),
    appStoreConnect<{ data: Array<{ id: string }> }>(env, `profiles/${old.id}/certificates`),
    appStoreConnect<DeviceList>(
      env,
      "devices?filter[status]=ENABLED&filter[platform]=IOS&limit=200",
    ),
  ]);
  await appStoreConnect(env, `profiles/${old.id}`, { method: "DELETE" });
  const created = await appStoreConnect<{ data: ProfileList["data"][number] }>(env, "profiles", {
    method: "POST",
    body: {
      data: {
        type: "profiles",
        attributes: { name: profileName(), profileType: "IOS_APP_ADHOC" },
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
  return storeProfile(env, created.data.id, created.data.attributes.profileContent);
}

export function bundleIdFor(target: string) {
  const apps = napConfig.apps;
  if (!apps) throw new AppleError("Apps are off on this Nap");
  return `${apps.bundleIdPrefix}.${target}`;
}

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
