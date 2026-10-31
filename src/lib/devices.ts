import { liveBuilds, ensureCurrentSignature, type AppsEnv } from "~/lib/apps";
import { AppleError, regenerateProfile, registerDevice } from "~/lib/apple";
import { randomString, sha256Hex } from "~/lib/agent-auth";
import { json } from "~/lib/nap-server";
import { napConfig } from "~/nap.config";

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

export async function addDevice(env: AppsEnv, addedBy: string, rawUdid: string, rawName: string) {
  const udid = normalizeUdid(rawUdid);
  if (!UDID.test(udid)) {
    return json(
      { error: "That is not an iPhone UDID. It looks like 00008120-001E31091E52201E." },
      { status: 400 },
    );
  }
  const name = rawName.trim().slice(0, 40) || "iPhone";
  const added = await registerAndSign(env, addedBy, udid, name, { resign: true });
  if (added.ok) return json({ ok: true, name, resigned: added.resigned });
  return json(
    {
      error: added.apple
        ? `Apple did not accept it: ${added.error}`
        : "Adding the iPhone failed. Try again.",
    },
    { status: 502 },
  );
}

/**
 * Registers an iPhone with Apple, records it, and makes a new profile. With resign, signs every
 * live build again now; otherwise each build is signed again when someone installs it.
 */
async function registerAndSign(
  env: AppsEnv,
  addedBy: string,
  udid: string,
  name: string,
  options: { product?: string; version?: string; resign?: boolean },
): Promise<{ ok: true; resigned: number } | { ok: false; apple: boolean; error: string }> {
  try {
    const deviceId = await registerDevice(env, udid, name);
    await env.DB.prepare(
      `INSERT INTO devices (udid, email, name, product, os_version, asc_device_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (udid) DO UPDATE SET email = excluded.email, name = excluded.name,
         product = excluded.product, os_version = excluded.os_version,
         asc_device_id = excluded.asc_device_id,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
      .bind(udid, addedBy, name, options.product ?? "", options.version ?? "", deviceId)
      .run();
    await regenerateProfile(env);
    const resigned = options.resign ? await resignLiveBuilds(env) : 0;
    console.log(JSON.stringify({ message: "Device added", by: addedBy, name, deviceId }));
    return { ok: true, resigned };
  } catch (error) {
    console.error(JSON.stringify({ message: "Adding a device failed", error: String(error) }));
    return {
      ok: false,
      apple: error instanceof AppleError,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

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
export async function enrollmentProfile(db: D1Database, email: string, origin: string) {
  const token = randomString(32);
  await db
    .prepare("INSERT INTO device_enrollments (token_hash, email, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), email, new Date(Date.now() + ENROLL_SECONDS * 1000).toISOString())
    .run();
  await db
    .prepare("DELETE FROM device_enrollments WHERE expires_at < ?")
    .bind(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .run();
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
}

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
export async function handleEnrollRequest(env: AppsEnv, request: Request, ctx?: ExecutionContext) {
  const url = new URL(request.url);
  const back = (query: string) =>
    new Response(null, { status: 301, headers: { location: `${url.origin}/apps?${query}` } });
  const token = url.pathname.slice(ENROLL_PREFIX.length);
  if (request.method !== "POST" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return new Response("Not found", { status: 404 });
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 64 * 1024) return new Response("Too large", { status: 413 });

  const claimed = await env.DB.prepare(
    `UPDATE device_enrollments SET used_at = ?1
     WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1
     RETURNING email`,
  )
    .bind(now(), await sha256Hex(token))
    .first<{ email: string }>();
  if (!claimed) return back("enroll_error=expired");

  const attributes = readAttributes(new Uint8Array(await request.arrayBuffer()));
  const udid = normalizeUdid(attributes?.udid ?? "");
  if (!attributes || !udid) return back("enroll_error=unreadable");
  const { product, version } = attributes;
  const name = `${claimed.email.split("@")[0]}'s ${product || "iPhone"}`;
  const added = await registerAndSign(env, claimed.email, udid, name, { product, version });
  // Sign the live builds for the new profile after answering, so Install is quick. Whatever is not
  // done by then is signed when someone installs it.
  if (added.ok) ctx?.waitUntil(resignLiveBuilds(env).catch(() => undefined));
  return back(added.ok ? "enrolled=1" : `enroll_error=${added.apple ? "apple" : "failed"}`);
}

/** Signs every live build for the current profile. Returns how many builds there are. */
async function resignLiveBuilds(env: AppsEnv) {
  const builds = await liveBuilds(env.DB);
  for (const build of builds) await ensureCurrentSignature(env, build);
  return builds.length;
}

/** Every registered iPhone, with who added it. The UDID is not shown. */
export async function listDevices(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT name, product, email AS addedBy, created_at AS createdAt FROM devices
       ORDER BY created_at`,
    )
    .all<{ name: string; product: string; addedBy: string; createdAt: string }>();
  return results;
}
