import { Cause, Effect } from "effect";
import { AppleError, regenerateProfile, registerDevice } from "~/lib/apple";
import { ensureCurrentSignature, liveBuilds } from "~/lib/apps";
import { napConfig } from "~/nap.config";
import { Database } from "~/server/database";
import { fail, failText, json } from "~/server/http";
import { inBackground } from "~/server/platform";
import { randomString, sha256Hex } from "~/server/tokens";

/**
 * iPhones that may install apps. Ad hoc builds only install on iPhones listed in the signing
 * profile, so a signed-in person pastes an iPhone's UDID in the dashboard. Nap registers it with
 * Apple, makes a new profile that lists every registered iPhone, and signs every live build again
 * with it, so the new iPhone can install them at once. Apple allows 100 iPhones per team per
 * membership year.
 *
 * Or from the iPhone itself: Safari downloads a profile-service .mobileconfig from
 * /api/devices/profile (Access protects it), the person installs it in Settings, and iOS posts
 * the UDID to /_nap/enroll/<token> without the Access cookie. Access bypasses that path; the
 * single-use token is the credential and says who asked. Builds are signed again when someone
 * installs them, or in the background right after the enrollment answers. The profile is unsigned, so iOS calls it
 * unverified, and nothing stays installed.
 */

/** 25 characters for iPhones since 2018 (00008xxx-xxxxxxxxxxxxxxxx), 40 hex characters before. */
const UDID = /^([0-9A-F]{8}-[0-9A-F]{16}|[0-9a-f]{40})$/;

export function normalizeUdid(value: string) {
  const trimmed = value.trim().replace(/\s+/g, "");
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{16}$/.test(trimmed)) return trimmed.toUpperCase();
  if (/^[0-9a-fA-F]{40}$/.test(trimmed)) return trimmed.toLowerCase();
  return "";
}

export const addDevice = Effect.fn("addDevice")(function* (
  addedBy: string,
  rawUdid: string,
  rawName: string,
) {
  const udid = normalizeUdid(rawUdid);
  if (!UDID.test(udid)) {
    return yield* fail(400, "That is not an iPhone UDID. It looks like 00008120-001E31091E52201E.");
  }
  const name = rawName.trim().slice(0, 40) || "iPhone";
  const added = yield* registerAndSign(addedBy, udid, name, { resign: true });
  if (added.ok) return json({ ok: true, name, resigned: added.resigned });
  return yield* fail(
    502,
    added.apple
      ? `Apple did not accept it: ${added.error}`
      : "Adding the iPhone failed. Try again.",
  );
});

type Added = { ok: true; resigned: number } | { ok: false; apple: boolean; error: string };

/**
 * Registers an iPhone with Apple, records it, and makes a new profile. With resign, signs every
 * live build again now; otherwise each build is signed again when someone installs it.
 */
const registerAndSign = Effect.fnUntraced(
  function* (
    addedBy: string,
    udid: string,
    name: string,
    options: { product?: string; version?: string; resign?: boolean },
  ) {
    const deviceId = yield* registerDevice(udid, name);
    const db = yield* Database;
    yield* db.run(
      `INSERT INTO devices (udid, email, name, product, os_version, asc_device_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (udid) DO UPDATE SET email = excluded.email, name = excluded.name,
         product = excluded.product, os_version = excluded.os_version,
         asc_device_id = excluded.asc_device_id,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      udid,
      addedBy,
      name,
      options.product ?? "",
      options.version ?? "",
      deviceId,
    );
    yield* regenerateProfile();
    const resigned = options.resign ? yield* resignLiveBuilds : 0;
    yield* Effect.logInfo("Device added").pipe(
      Effect.annotateLogs({ by: addedBy, name, deviceId }),
    );
    const added: Added = { ok: true, resigned };
    return added;
  },
  // Any failure, expected or not, becomes a result: Apple's errors are shown to the person.
  Effect.catchCause((cause) => {
    const error = Cause.squash(cause);
    const failed: Added = {
      ok: false,
      apple: error instanceof AppleError,
      error: error instanceof Error ? error.message : String(error),
    };
    return Effect.logError("Adding a device failed").pipe(
      Effect.annotateLogs({ error: String(error) }),
      Effect.as(failed),
    );
  }),
);

export const ENROLL_PREFIX = "/_nap/enroll/";
/** A day: iOS may hold a profile install for an hour away from familiar places. */
const ENROLL_SECONDS = 24 * 60 * 60;
const now = () => new Date().toISOString();

const xml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!,
  );

/** A profile-service .mobileconfig for the signed-in person, valid for 30 minutes. */
export const enrollmentProfile = Effect.fn("enrollmentProfile")(function* (
  email: string,
  origin: string,
) {
  const db = yield* Database;
  const token = randomString(32);
  yield* db.run(
    "INSERT INTO device_enrollments (token_hash, email, expires_at) VALUES (?, ?, ?)",
    yield* sha256Hex(token),
    email,
    new Date(Date.now() + ENROLL_SECONDS * 1000).toISOString(),
  );
  yield* db.run(
    "DELETE FROM device_enrollments WHERE expires_at < ?",
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  );
  const name = napConfig.orgName;
  const prefix = napConfig.apps?.bundleIdPrefix ?? "nap";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key>
    <string>${xml(`${origin}${ENROLL_PREFIX}${token}`)}</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string>
      <string>PRODUCT</string>
      <string>VERSION</string>
    </array>
  </dict>
  <key>PayloadOrganization</key>
  <string>${xml(name)}</string>
  <key>PayloadDisplayName</key>
  <string>${xml(`Add this iPhone to ${name}`)}</string>
  <key>PayloadDescription</key>
  <string>${xml(`Sends this iPhone's device ID to ${name} so it can install ${name} apps. Nothing stays installed.`)}</string>
  <key>PayloadIdentifier</key>
  <string>${xml(`${prefix}.enroll`)}</string>
  <key>PayloadUUID</key>
  <string>${crypto.randomUUID().toUpperCase()}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadType</key>
  <string>Profile Service</string>
</dict>
</plist>
`;
});

export const isEnrollPath = (pathname: string) => pathname.startsWith(ENROLL_PREFIX);

/** The device attributes iOS posts: a CMS envelope around a plain XML plist. */
function readAttributes(body: Uint8Array) {
  const text = new TextDecoder("latin1").decode(body);
  const start = text.indexOf("<?xml");
  const end = text.indexOf("</plist>");
  if (start < 0 || end < 0) return null;
  const plist = text.slice(start, end);
  const field = (key: string) =>
    plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1]?.trim() ?? "";
  return { udid: field("UDID"), product: field("PRODUCT"), version: field("VERSION") };
}

/**
 * POST /_nap/enroll/<token>, from iOS. Never uses getIdentity(): Access bypasses this path.
 * Answers with a redirect, which iOS opens in Safari.
 */
export const handleEnrollRequest = Effect.fn("handleEnrollRequest")(function* (request: Request) {
  const url = new URL(request.url);
  const back = (query: string) =>
    new Response(null, { status: 301, headers: { location: `${url.origin}/apps?${query}` } });
  const token = url.pathname.slice(ENROLL_PREFIX.length);
  if (request.method !== "POST" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return yield* failText(404, "Not found");
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 64 * 1024) return yield* failText(413, "Too large");

  const db = yield* Database;
  const claimed = yield* db.first<{ email: string }>(
    `UPDATE device_enrollments SET used_at = ?1
     WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1
     RETURNING email`,
    now(),
    yield* sha256Hex(token),
  );
  if (!claimed) return back("enroll_error=expired");

  const attributes = readAttributes(
    new Uint8Array(yield* Effect.promise(() => request.arrayBuffer())),
  );
  const udid = normalizeUdid(attributes?.udid ?? "");
  if (!attributes || !udid) return back("enroll_error=unreadable");
  const { product, version } = attributes;
  const name = `${claimed.email.split("@")[0]}'s ${product || "iPhone"}`;
  const added = yield* registerAndSign(claimed.email, udid, name, { product, version });
  // Sign the live builds for the new profile after answering, so Install is quick. Whatever is not
  // done by then is signed when someone installs it.
  if (added.ok) {
    yield* inBackground(
      Effect.asVoid(resignLiveBuilds),
      "Signing live builds after enrollment failed",
    );
  }
  return back(added.ok ? "enrolled=1" : `enroll_error=${added.apple ? "apple" : "failed"}`);
});

/** Signs every live build for the current profile. Returns how many builds there are. */
const resignLiveBuilds = Effect.gen(function* () {
  const builds = yield* liveBuilds;
  for (const build of builds) yield* ensureCurrentSignature(build);
  return builds.length;
});

/** Every registered iPhone, with who added it. The UDID is not shown. */
export const listDevices = Effect.fn("listDevices")(function* () {
  const db = yield* Database;
  return yield* db.all<{ name: string; product: string; addedBy: string; createdAt: string }>(
    `SELECT name, product, email AS addedBy, created_at AS createdAt FROM devices
     ORDER BY created_at`,
  );
});
