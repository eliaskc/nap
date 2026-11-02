import { Effect, Schema } from "effect";
import { importPKCS8, SignJWT } from "jose";
import { napConfig } from "~/nap.config";
import { Settings } from "~/server/platform";
import { Storage, tryStorage } from "~/server/storage";

/**
 * Apple's side of apps: the App Store Connect API, the provisioning profiles, and TestFlight.
 *
 * Nap signs with one Apple Distribution certificate. Ad hoc builds use a profile for a wildcard
 * App ID (<bundleIdPrefix>.*) that lists the devices that may install. TestFlight builds use an
 * App Store profile for the app record's explicit bundle id, and Nap uploads them with the build
 * upload API. Nap reads profiles by name through the App Store Connect API and keeps a copy in
 * R2, so signing does not call Apple.
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

/**
 * The two ways Nap signs: "adhoc" for every target, installed from /apps on registered iPhones,
 * and "appstore" for the TestFlight launcher, uploaded to App Store Connect.
 */
export type Distribution = "adhoc" | "appstore";

const PROFILES = {
  adhoc: { type: "IOS_APP_ADHOC", key: PROFILE_KEY, label: "ad hoc" },
  appstore: {
    type: "IOS_APP_STORE",
    key: "apps/_signing/appstore.mobileprovision",
    label: "App Store",
  },
} as const;

const profileName = (kind: Distribution) =>
  Effect.suspend(() => {
    const name =
      kind === "adhoc" ? napConfig.apps?.profileName : napConfig.apps?.testFlight?.profileName;
    return name
      ? Effect.succeed(name)
      : Effect.fail(
          new AppleError({
            message:
              kind === "adhoc"
                ? "Ad hoc installs are off on this Nap"
                : "TestFlight is off on this Nap",
          }),
        );
  });

/** The active profile of a kind with Nap's profile name, from Apple. */
const currentProfile = Effect.fnUntraced(function* (kind: Distribution) {
  const name = yield* profileName(kind);
  const list = yield* appStoreConnect<ProfileList>(
    `profiles?filter[name]=${encodeURIComponent(name)}&filter[profileType]=${PROFILES[kind].type}&limit=10`,
  );
  return (
    list.data.find(
      (item) => item.attributes.name === name && item.attributes.profileState === "ACTIVE",
    ) ?? null
  );
});

const storeProfile = Effect.fnUntraced(function* (kind: Distribution, id: string, content: string) {
  const storage = yield* Storage;
  const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  yield* storage.put(PROFILES[kind].key, bytes, {
    customMetadata: { profileId: id, fetchedAt: new Date().toISOString() },
  });
  const profile: SigningProfile = { id, bytes };
  return profile;
});

const missingProfile = (kind: Distribution) =>
  Effect.gen(function* () {
    return yield* new AppleError({
      message: `No active ${PROFILES[kind].label} profile named "${yield* profileName(kind)}"`,
    });
  });

/** Fetches a profile from Apple by name and stores it in R2. */
export const refreshProfile = Effect.fn("refreshProfile")(function* (kind: Distribution = "adhoc") {
  const profile = yield* currentProfile(kind);
  if (!profile) return yield* missingProfile(kind);
  return yield* storeProfile(kind, profile.id, profile.attributes.profileContent);
});

/** How long the copy in R2 is trusted before Nap asks Apple again. */
const PROFILE_TTL_MS = 60 * 60 * 1000;

/**
 * The profile to sign with: the copy in R2 when it is under an hour old, else Apple's. If Apple
 * cannot be reached, the copy is still used.
 */
export const signingProfile = Effect.fn("signingProfile")(function* (kind: Distribution = "adhoc") {
  const storage = yield* Storage;
  const stored = yield* storage.get(PROFILES[kind].key);
  const id = stored?.customMetadata?.profileId;
  const fetchedAt = Date.parse(stored?.customMetadata?.fetchedAt ?? "");
  if (stored && id) {
    const copy: SigningProfile = {
      id,
      bytes: new Uint8Array(yield* tryStorage(() => stored.arrayBuffer())),
    };
    if (Date.now() - fetchedAt < PROFILE_TTL_MS) return copy;
    // Any failure, expected or not, falls back to the copy.
    return yield* refreshProfile(kind).pipe(Effect.catchCause(() => Effect.succeed(copy)));
  }
  return yield* refreshProfile(kind);
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
  const old = yield* currentProfile("adhoc");
  if (!old) return yield* missingProfile("adhoc");
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
        attributes: { name: yield* profileName("adhoc"), profileType: "IOS_APP_ADHOC" },
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
  return yield* storeProfile("adhoc", created.data.id, created.data.attributes.profileContent);
});

// ---- TestFlight ----

const testFlightApp = Effect.suspend(() => {
  const testFlight = napConfig.apps?.testFlight;
  return testFlight
    ? Effect.succeed(testFlight)
    : Effect.fail(new AppleError({ message: "TestFlight is off on this Nap" }));
});

type VersionList = { data: Array<{ attributes: { version?: string; cfBundleVersion?: string } }> };

/**
 * The highest build number App Store Connect has for the TestFlight app, from uploads and builds,
 * or 0. Build numbers must go up, and builds can also arrive from Xcode or an earlier Nap.
 */
export const latestTestFlightBuildNumber = Effect.fn("latestTestFlightBuildNumber")(function* () {
  const { appStoreId } = yield* testFlightApp;
  const [uploads, builds] = yield* Effect.all(
    [
      appStoreConnect<VersionList>(
        `apps/${appStoreId}/buildUploads?fields[buildUploads]=cfBundleVersion&sort=-uploadedDate&limit=200`,
      ),
      appStoreConnect<VersionList>(
        `builds?filter[app]=${appStoreId}&fields[builds]=version&sort=-uploadedDate&limit=200`,
      ),
    ],
    { concurrency: "unbounded" },
  );
  let latest = 0;
  for (const item of [...uploads.data, ...builds.data]) {
    const value = Number(item.attributes.cfBundleVersion ?? item.attributes.version);
    if (Number.isInteger(value) && value > latest) latest = value;
  }
  return latest;
});

type UploadOperation = {
  method: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders?: Array<{ name: string; value: string }>;
};

/**
 * Uploads a signed .ipa from R2 to App Store Connect with the build upload API and returns the
 * upload's id. Apple processes it afterwards; buildUploadStatus follows that.
 */
export const uploadToTestFlight = Effect.fn("uploadToTestFlight")(function* (
  ipaKey: string,
  shortVersion: string,
  buildNumber: number,
) {
  const { appStoreId } = yield* testFlightApp;
  const storage = yield* Storage;
  const head = yield* storage.head(ipaKey);
  if (!head) return yield* new AppleError({ message: "The signed build is missing" });

  const upload = yield* appStoreConnect<{ data: { id: string } }>("buildUploads", {
    method: "POST",
    body: {
      data: {
        type: "buildUploads",
        attributes: {
          cfBundleShortVersionString: shortVersion || "1.0",
          cfBundleVersion: String(buildNumber),
          platform: "IOS",
        },
        relationships: { app: { data: { type: "apps", id: appStoreId } } },
      },
    },
  });
  const file = yield* appStoreConnect<{
    data: { id: string; attributes: { uploadOperations: Array<UploadOperation> } };
  }>("buildUploadFiles", {
    method: "POST",
    body: {
      data: {
        type: "buildUploadFiles",
        attributes: {
          assetType: "ASSET",
          fileName: "app.ipa",
          fileSize: head.size,
          uti: "com.apple.ipa",
        },
        relationships: { buildUpload: { data: { type: "buildUploads", id: upload.data.id } } },
      },
    },
  });

  for (const operation of file.data.attributes.uploadOperations) {
    const part = yield* storage.get(ipaKey, {
      range: { offset: operation.offset, length: operation.length },
    });
    if (!part) return yield* new AppleError({ message: "The signed build is missing" });
    const { readable, writable } = new FixedLengthStream(operation.length);
    void part.body.pipeTo(writable).catch(() => undefined);
    const response = yield* Effect.promise(() =>
      fetch(operation.url, {
        method: operation.method,
        headers: Object.fromEntries(
          (operation.requestHeaders ?? []).map((header) => [header.name, header.value]),
        ),
        body: readable,
      }),
    );
    if (!response.ok) {
      return yield* new AppleError({
        message: `Uploading to App Store Connect failed (${response.status})`,
      });
    }
  }

  const whole = yield* storage.get(ipaKey);
  if (!whole) return yield* new AppleError({ message: "The signed build is missing" });
  // Workers' crypto.DigestStream hashes a stream; the DOM types do not know it.
  const { DigestStream: Digest } = crypto as unknown as { DigestStream: typeof DigestStream };
  const digest = new Digest("MD5");
  yield* Effect.promise(() => whole.body.pipeTo(digest));
  const md5 = [...new Uint8Array(yield* Effect.promise(() => digest.digest))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  yield* appStoreConnect(`buildUploadFiles/${file.data.id}`, {
    method: "PATCH",
    body: {
      data: {
        type: "buildUploadFiles",
        id: file.data.id,
        attributes: {
          uploaded: true,
          sourceFileChecksums: { file: { hash: md5, algorithm: "MD5" } },
        },
      },
    },
  });
  return upload.data.id;
});

/** Where a TestFlight build is: Apple still processing it, ready for testers, or failed. */
export type TestFlightStatus =
  | { state: "processing" }
  | { state: "ready" }
  | { state: "failed"; error: string };

type StateDetails = Array<{ code?: string; description?: string }>;

const describeDetails = (details: StateDetails | undefined, fallback: string) =>
  (details ?? [])
    .map((detail) => detail.description || detail.code)
    .filter(Boolean)
    .join(" ")
    .slice(0, 1000) || fallback;

/** Asks App Store Connect where an upload is. */
export const buildUploadStatus = Effect.fn("buildUploadStatus")(function* (uploadId: string) {
  const upload = yield* appStoreConnect<{
    data: {
      attributes: { state?: { state?: string; errors?: StateDetails } };
      relationships?: { build?: { data?: { id: string } | null } };
    };
    included?: Array<{ type: string; id: string; attributes: { processingState?: string } }>;
  }>(`buildUploads/${uploadId}?include=build&fields[builds]=processingState`);
  const state = upload.data.attributes.state;
  if (state?.state === "FAILED") {
    return {
      state: "failed",
      error: describeDetails(state.errors, "App Store Connect did not accept the build."),
    } satisfies TestFlightStatus;
  }
  const buildId = upload.data.relationships?.build?.data?.id;
  if (state?.state !== "COMPLETE" || !buildId) return { state: "processing" } as TestFlightStatus;
  const build = upload.included?.find((item) => item.type === "builds" && item.id === buildId);
  const processing = build?.attributes.processingState;
  if (processing === "FAILED" || processing === "INVALID") {
    return {
      state: "failed",
      error: "Apple could not process the build. App Store Connect has the details.",
    } satisfies TestFlightStatus;
  }
  if (processing !== "VALID") return { state: "processing" } as TestFlightStatus;
  const beta = yield* appStoreConnect<{ data: { attributes: { internalBuildState?: string } } }>(
    `builds/${buildId}/buildBetaDetail`,
  );
  switch (beta.data.attributes.internalBuildState) {
    case "READY_FOR_BETA_TESTING":
    case "IN_BETA_TESTING":
      return { state: "ready" } as TestFlightStatus;
    case "MISSING_EXPORT_COMPLIANCE":
      return {
        state: "failed",
        error:
          "The build needs an export compliance answer. Set ITSAppUsesNonExemptEncryption in its Info.plist, or answer in App Store Connect.",
      } satisfies TestFlightStatus;
    case "EXPIRED":
      return {
        state: "failed",
        error: "The build expired in TestFlight.",
      } satisfies TestFlightStatus;
    default:
      return { state: "processing" } as TestFlightStatus;
  }
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
