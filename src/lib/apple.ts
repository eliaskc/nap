import { Effect, Schedule, Schema } from "effect";
import { importPKCS8, SignJWT } from "jose";
import { napConfig } from "~/nap.config";
import { Settings } from "~/server/platform";
import { Storage, tryStorage } from "~/server/storage";

/**
 * Apple's side of apps: the App Store Connect API, the provisioning profiles, and TestFlight.
 *
 * Nap signs with one Apple Distribution certificate and an App Store profile for the app record's
 * explicit bundle id, and uploads builds with the build upload API. Nap reads the profile by name
 * through the App Store Connect API and keeps a copy in R2. The App ID, the profile, and the app
 * record are made by hand; Nap only remakes the profile when it turns a capability on.
 */

const PROFILE_KEY = "apps/_signing/appstore.mobileprovision";
const PROFILE_TYPE = "IOS_APP_STORE";
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
    yield* Effect.logWarning("App Store Connect request failed").pipe(
      Effect.annotateLogs({
        method: init.method ?? "GET",
        path: path.split("?")[0],
        status: response.status,
      }),
    );
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

const profileName = Effect.suspend(() => {
  const name = napConfig.apps?.testFlight.profileName;
  return name
    ? Effect.succeed(name)
    : Effect.fail(new AppleError({ message: "Apps are off on this Nap" }));
});

/**
 * The App Store profile with the configured name: the active one, else one Apple made invalid (it
 * does when a capability of the App ID changes), which only regenerating fixes.
 */
const namedProfile = Effect.fnUntraced(function* () {
  const name = yield* profileName;
  const list = yield* appStoreConnect<ProfileList>(
    `profiles?filter[name]=${encodeURIComponent(name)}&filter[profileType]=${PROFILE_TYPE}&limit=10`,
  );
  const named = list.data.filter((item) => item.attributes.name === name);
  return named.find((item) => item.attributes.profileState === "ACTIVE") ?? named[0] ?? null;
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

const missingProfile = Effect.gen(function* () {
  return yield* new AppleError({
    message: `No App Store profile named "${yield* profileName}". Make it in the developer account.`,
  });
});

/** Fetches the profile from Apple by name and stores it in R2. */
export const refreshProfile = Effect.fn("refreshProfile")(function* () {
  const profile = yield* namedProfile();
  if (!profile) return yield* missingProfile;
  if (profile.attributes.profileState !== "ACTIVE") {
    yield* Effect.logInfo("Profile invalid, regenerating");
    return yield* regenerateProfile();
  }
  return yield* storeProfile(profile.id, profile.attributes.profileContent);
});

/** How long the copy in R2 is trusted before Nap asks Apple again. */
const PROFILE_TTL_MS = 60 * 60 * 1000;

/**
 * The profile to sign with: the copy in R2 when it is under an hour old, else Apple's. If Apple
 * cannot be reached, the copy is still used.
 */
export const signingProfile = Effect.fn("signingProfile")(function* ({
  fresh = false,
}: { fresh?: boolean } = {}) {
  const storage = yield* Storage;
  const stored = yield* storage.get(PROFILE_KEY);
  const id = stored?.customMetadata?.profileId;
  const fetchedAt = Date.parse(stored?.customMetadata?.fetchedAt ?? "");
  if (stored && id) {
    const copy: SigningProfile = {
      id,
      bytes: new Uint8Array(yield* tryStorage(() => stored.arrayBuffer())),
    };
    if (!fresh && Date.now() - fetchedAt < PROFILE_TTL_MS) return copy;
    // Any failure, expected or not, falls back to the copy.
    return yield* refreshProfile().pipe(Effect.catchCause(() => Effect.succeed(copy)));
  }
  return yield* refreshProfile();
});

/**
 * Replaces the profile with a new one with the same name, App ID, and certificates, so it picks up
 * the App ID's capabilities: Apple profiles cannot be edited.
 */
export const regenerateProfile = Effect.fn("regenerateProfile")(function* () {
  const old = yield* namedProfile();
  if (!old) return yield* missingProfile;
  const [bundle, certificates] = yield* Effect.all(
    [
      appStoreConnect<{ data: { id: string } }>(`profiles/${old.id}/bundleId`),
      appStoreConnect<{ data: Array<{ id: string }> }>(`profiles/${old.id}/certificates`),
    ],
    { concurrency: "unbounded" },
  );
  yield* appStoreConnect(`profiles/${old.id}`, { method: "DELETE" });
  const created = yield* appStoreConnect<{ data: ProfileList["data"][number] }>("profiles", {
    method: "POST",
    body: {
      data: {
        type: "profiles",
        attributes: { name: yield* profileName, profileType: PROFILE_TYPE },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundle.data.id } },
          certificates: {
            data: certificates.data.map((item) => ({ type: "certificates", id: item.id })),
          },
        },
      },
    },
  });
  return yield* storeProfile(created.data.id, created.data.attributes.profileContent);
});

// ---- TestFlight ----

const testFlightApp = Effect.suspend(() => {
  const testFlight = napConfig.apps?.testFlight;
  return testFlight
    ? Effect.succeed(testFlight)
    : Effect.fail(new AppleError({ message: "Apps are off on this Nap" }));
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
  // Apple sometimes answers this with a 500 that a moment later is a 200.
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
  }).pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 2 }));
  return upload.data.id;
});

type BundleIdList = { data: Array<{ id: string; attributes: { identifier: string } }> };
type CapabilityList = { data: Array<{ attributes: { capabilityType: string } }> };

/**
 * Turns capabilities on for the TestFlight app's App ID (Apple's capability types, such as
 * PUSH_NOTIFICATIONS) and makes a new App Store profile when any was off, so it carries their
 * entitlements. Returns Apple's reason for each one it would not turn on.
 */
export const ensureCapabilities = Effect.fn("ensureCapabilities")(function* (
  types: ReadonlyArray<string>,
) {
  const refused = new Map<string, string>();
  if (types.length === 0) return refused;
  const { bundleId } = yield* testFlightApp;
  const bundles = yield* appStoreConnect<BundleIdList>(
    `bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&fields[bundleIds]=identifier&limit=20`,
  );
  const bundle = bundles.data.find((item) => item.attributes.identifier === bundleId);
  if (!bundle) return yield* new AppleError({ message: `No App ID ${bundleId}` });
  const enabled = yield* appStoreConnect<CapabilityList>(
    `bundleIds/${bundle.id}/bundleIdCapabilities`,
  );
  const on = new Set(enabled.data.map((item) => item.attributes.capabilityType));
  let changed = false;
  for (const type of types) {
    if (on.has(type)) continue;
    const added = yield* appStoreConnect("bundleIdCapabilities", {
      method: "POST",
      body: {
        data: {
          type: "bundleIdCapabilities",
          attributes: { capabilityType: type },
          relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } } },
        },
      },
    }).pipe(
      Effect.as(true),
      Effect.catchTag("AppleError", (error) => {
        refused.set(type, error.message);
        return Effect.succeed(false);
      }),
    );
    if (added) {
      changed = true;
      yield* Effect.logInfo("Capability turned on").pipe(
        Effect.annotateLogs({ bundleId, capability: type }),
      );
    }
  }
  if (changed) yield* regenerateProfile();
  return refused;
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

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
