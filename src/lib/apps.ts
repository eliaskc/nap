import { getContainer } from "@cloudflare/containers";
import type { AgentIdentity } from "~/lib/agent-auth";
import { randomString, readParams, sha256Hex } from "~/lib/agent-auth";
import { appTemplateFiles } from "~/lib/app-template";
import { AppleError, bundleIdFor, signingProfile, toBase64, type AppleEnv } from "~/lib/apple";
import type { AppSigner } from "~/lib/app-signer";
import { json, slugify } from "~/lib/nap-server";
import {
  checkRepoCommit,
  containsCommit,
  createNamedRepo,
  deleteSourceRepo,
  mintSourceToken,
  repoHead,
  type SourceEnv,
} from "~/lib/sources";
import { napConfig } from "~/nap.config";

/**
 * Native apps. See migrations/0018_apps.sql for the model.
 *
 * 1. An agent creates an app: Nap makes its source repo (Artifacts) and returns a Git token.
 * 2. The agent pushes the Xcode project to main, builds a target on a Mac without signing, and
 *    uploads the zipped .app with the commit it built: POST /_nap/api/apps/<app>/builds.
 * 3. Nap checks the commit like a site's (head of main, contains the target's live build), stores
 *    the unsigned build, signs it in the signer container, stores the .ipa, and makes it live.
 * 4. People install from the dashboard. An install link is a short-lived token that the iOS
 *    installer uses for the manifest and the .ipa, since it sends no Access cookie.
 *
 * Every person who can sign in can see, push to, publish, and install every app.
 */

export type AppsEnv = SourceEnv &
  AppleEnv & {
    DB: D1Database;
    SITES: R2Bucket;
    SIGNER?: DurableObjectNamespace<AppSigner>;
    /** Local stages only: a signer run by plain Docker instead of the container binding. */
    NAP_SIGNER_URL?: string;
  };

type AppRow = {
  slug: string;
  title: string;
  sourceRepo: string;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
};

type TargetRow = {
  appSlug: string;
  target: string;
  bundleId: string;
  title: string;
  liveBuild: string | null;
  updatedAt: string;
};

type BuildRow = {
  id: string;
  appSlug: string;
  target: string;
  buildNumber: number;
  sourceCommit: string;
  status: "signing" | "ready" | "failed";
  error: string | null;
  notes: string;
  appName: string;
  shortVersion: string;
  xcode: string;
  signedBytes: number;
  signedKey: string | null;
  signedProfile: string | null;
  createdByEmail: string;
  client: string;
  createdAt: string;
};

const APP_COLUMNS = `slug, title, source_repo AS sourceRepo, created_by_email AS createdByEmail,
  created_at AS createdAt, updated_at AS updatedAt`;
const TARGET_COLUMNS = `app_slug AS appSlug, target, bundle_id AS bundleId, title,
  live_build AS liveBuild, updated_at AS updatedAt`;
const BUILD_COLUMNS = `id, app_slug AS appSlug, target, build_number AS buildNumber,
  source_commit AS sourceCommit, status, error, notes, app_name AS appName,
  short_version AS shortVersion, xcode, signed_bytes AS signedBytes,
  signed_key AS signedKey, signed_profile AS signedProfile, created_by_email AS createdByEmail, client, created_at AS createdAt`;

const TARGET_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** Workers take request bodies up to 100 MB. Prototypes are far smaller. */
export const MAX_APP_BYTES = 95 * 1024 * 1024;
const INSTALL_LINK_SECONDS = 60 * 60;
export const INSTALL_PREFIX = "/_nap/install/";
const noStore = { "cache-control": "no-store" };
const now = () => new Date().toISOString();

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  json({ error, ...extra }, { status, headers: noStore });

export const appsEnabled = () => napConfig.apps !== null;

const unsignedKey = (app: string, build: string) => `apps/${app}/builds/${build}/unsigned.zip`;
/** Builds signed before re-signing existed are at signed.ipa; later ones name their profile. */
const signedKey = (app: string, build: string, profile?: string) =>
  `apps/${app}/builds/${build}/${profile ? `signed-${profile}` : "signed"}.ipa`;

/** The agent API under /_nap/api/apps. `path` starts after /apps. */
export async function handleAppsApi(
  env: AppsEnv,
  request: Request,
  url: URL,
  agent: AgentIdentity,
  path: string,
) {
  if (!appsEnabled()) return fail(404, "Apps are off on this Nap", { code: "apps_off" });
  const method = request.method;

  if (path === "" && method === "GET") {
    return json({ apps: await listApps(env.DB, url.origin) }, { headers: noStore });
  }
  if (path === "" && method === "POST") {
    const params = await readParams(request, url);
    return createApp(env, agent, params.slug ?? "", params.title ?? "");
  }
  if (path === "/template" && method === "GET") {
    return json({ files: appTemplateFiles() }, { headers: noStore });
  }

  const match = path.match(/^\/([a-z0-9-]{1,32})(\/.*)?$/);
  if (!match) return fail(404, "Not found");
  const app = await getApp(env.DB, match[1]);
  if (!app) return fail(404, "App not found");
  const rest = match[2] ?? "";

  if (rest === "" && method === "GET") {
    const source = await repoHead(env, app.sourceRepo);
    if (source instanceof Response) return source;
    return json({ app: await describeApp(env.DB, app, url.origin), source }, { headers: noStore });
  }
  if (rest === "/source/token" && method === "POST") {
    const params = await readParams(request, url);
    const scope = params.access ?? "write";
    if (scope !== "read" && scope !== "write") {
      return fail(400, 'access must be "read" or "write"');
    }
    const access = await mintSourceToken(env, app.sourceRepo, scope);
    if (access instanceof Response) return access;
    logAppEvent(agent, app.slug, `source-${scope}`);
    return json({ source: access }, { headers: noStore });
  }
  if (rest === "/builds" && method === "POST") {
    return publishBuild(env, request, url, agent, app);
  }
  if (rest === "/builds" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT ${BUILD_COLUMNS} FROM app_builds WHERE app_slug = ? ORDER BY created_at DESC LIMIT 50`,
    )
      .bind(app.slug)
      .all<BuildRow>();
    return json({ builds: results.map(describeBuild) }, { headers: noStore });
  }
  // The live build of a target, with a fresh install link. Apps call this to check for updates.
  const targetMatch = rest.match(/^\/targets\/([a-z][a-z0-9-]{0,31})$/);
  if (targetMatch && method === "GET") {
    const live = await liveBuild(env.DB, app.slug, targetMatch[1]);
    if (!live) return fail(404, "This target has no live build", { code: "no_live_build" });
    await ensureCurrentSignature(env, live);
    const install = await createInstallLink(env.DB, live.id, agent.email, url.origin);
    return json({ build: describeBuild(live), install }, { headers: noStore });
  }
  return fail(404, "Not found");
}

async function createApp(env: AppsEnv, agent: AgentIdentity, rawSlug: string, rawTitle: string) {
  const slug = slugify(rawSlug);
  if (!slug) return fail(400, "slug is required: lowercase letters, numbers, and hyphens");
  const title = rawTitle.trim().slice(0, 120) || slug;
  if (await getApp(env.DB, slug)) {
    return fail(409, `The app ${slug} already exists. Clone it instead.`, { code: "app_exists" });
  }
  const repo = await createNamedRepo(env, `app-${slug}`, title);
  if (repo instanceof Response) return repo;
  const inserted = await env.DB.prepare(
    `INSERT INTO apps (slug, title, source_repo, created_by_email) VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(slug, title, repo, agent.email)
    .run();
  if (inserted.meta.changes !== 1) {
    await deleteSourceRepo(env, repo);
    return fail(409, `The app ${slug} already exists. Clone it instead.`, { code: "app_exists" });
  }
  const access = await mintSourceToken(env, repo, "write");
  if (access instanceof Response) return access;
  logAppEvent(agent, slug, "create");
  return json(
    {
      app: { slug, title },
      source: access,
      next: "Start from the template (GET /_nap/api/apps/template), push it to main, then build a target and POST it to /_nap/api/apps/<slug>/builds.",
    },
    { status: 201, headers: noStore },
  );
}

/**
 * POST /_nap/api/apps/<app>/builds?target=<target>&sourceCommit=<sha>&notes=<text>
 * Body: a zip of the unsigned .app (content-type application/zip).
 */
async function publishBuild(
  env: AppsEnv,
  request: Request,
  url: URL,
  agent: AgentIdentity,
  app: AppRow,
) {
  const target = (url.searchParams.get("target") ?? "").trim();
  const commit = (url.searchParams.get("sourceCommit") ?? "").trim().toLowerCase();
  const notes = (url.searchParams.get("notes") ?? "").trim().slice(0, 2000);
  if (!TARGET_PATTERN.test(target)) {
    return fail(
      400,
      "target must start with a letter and use lowercase letters, numbers, and hyphens",
    );
  }
  const size = Number(request.headers.get("content-length"));
  if (!request.body || !Number.isFinite(size) || size <= 0) {
    return fail(411, "Send the zipped .app as the body, with a content-length");
  }
  if (size > MAX_APP_BYTES) return fail(413, "The app is larger than 95 MB");
  if (!env.SIGNER && !env.NAP_SIGNER_URL) {
    return fail(503, "The app signer is not set up", { code: "signer_unavailable" });
  }

  // The target: new targets get their bundle id now, so a name cannot be taken twice.
  let targetRow = await getTarget(env.DB, app.slug, target);
  if (!targetRow) {
    const bundleId = bundleIdFor(target);
    const taken = await env.DB.prepare(
      `SELECT app_slug AS appSlug FROM app_targets WHERE bundle_id = ?`,
    )
      .bind(bundleId)
      .first<{ appSlug: string }>();
    if (taken) {
      return fail(
        409,
        `The target name ${target} is used by the app ${taken.appSlug}. Pick another.`,
        {
          code: "target_taken",
        },
      );
    }
  }
  const live = targetRow?.liveBuild ? await getBuild(env.DB, targetRow.liveBuild) : null;
  const sourceProblem = await checkRepoCommit(
    env,
    app.sourceRepo,
    commit,
    live?.sourceCommit ?? null,
  );
  if (sourceProblem) return sourceProblem;

  if (!targetRow) {
    await env.DB.prepare(
      `INSERT INTO app_targets (app_slug, target, bundle_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(app.slug, target, bundleIdFor(target))
      .run();
    targetRow = await getTarget(env.DB, app.slug, target);
    if (!targetRow) return fail(409, `The target name ${target} is taken. Pick another.`);
  }

  const numbered = await env.DB.prepare(
    `UPDATE app_targets SET next_build_number = next_build_number + 1
     WHERE app_slug = ? AND target = ? RETURNING next_build_number - 1 AS buildNumber`,
  )
    .bind(app.slug, target)
    .first<{ buildNumber: number }>();
  const buildNumber = numbered!.buildNumber;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO app_builds (id, app_slug, target, build_number, source_commit, status, notes,
                             unsigned_bytes, created_by_email, client)
     VALUES (?, ?, ?, ?, ?, 'signing', ?, ?, ?, ?)`,
  )
    .bind(
      id,
      app.slug,
      target,
      buildNumber,
      commit,
      notes,
      size,
      agent.email,
      agent.client.slice(0, 80),
    )
    .run();

  const failBuild = async (status: number, error: string) => {
    await env.DB.prepare("UPDATE app_builds SET status = 'failed', error = ? WHERE id = ?")
      .bind(error, id)
      .run();
    return fail(status, error, { code: "build_failed", buildId: id });
  };

  // Keep the unsigned build: a new device means signing it again, not building it again.
  await env.SITES.put(unsignedKey(app.slug, id), fixedLength(request.body, size), {
    httpMetadata: { contentType: "application/zip" },
  });

  let signed: Awaited<ReturnType<typeof signBuild>>;
  try {
    signed = await signBuild(env, app.slug, id, targetRow.bundleId, buildNumber);
  } catch (error) {
    if (error instanceof SignError) return failBuild(error.status, error.message);
    if (error instanceof AppleError) return failBuild(503, error.message);
    throw error;
  }
  await env.DB.prepare(
    `UPDATE app_builds SET status = 'ready', app_name = ?, short_version = ?, xcode = ?,
                           signed_bytes = ?, signed_key = ?, signed_profile = ?
     WHERE id = ?`,
  )
    .bind(
      signed.appName,
      signed.shortVersion,
      signed.xcode,
      signed.bytes,
      signed.key,
      signed.profileId,
      id,
    )
    .run();

  // Go live, unless another build of this target went live meanwhile with commits this one lacks.
  let previous = targetRow.liveBuild;
  for (let attempt = 0; attempt < 3; attempt++) {
    const moved = await env.DB.prepare(
      `UPDATE app_targets SET live_build = ?1, title = ?2, updated_at = ?3
       WHERE app_slug = ?4 AND target = ?5 AND live_build IS ?6`,
    )
      .bind(id, signed.appName || targetRow.title, now(), app.slug, target, previous)
      .run();
    if (moved.meta.changes === 1) break;
    const current = await getTarget(env.DB, app.slug, target);
    const currentBuild = current?.liveBuild ? await getBuild(env.DB, current.liveBuild) : null;
    if (
      currentBuild &&
      !(await containsCommit(env, app.sourceRepo, commit, currentBuild.sourceCommit))
    ) {
      return fail(
        409,
        `Build ${currentBuild.buildNumber} of ${target} went live while this one was signing, and this build does not contain its commit. Pull, build again, and publish.`,
        { code: "source_not_descendant", buildId: id },
      );
    }
    previous = current?.liveBuild ?? null;
  }
  await env.DB.prepare("UPDATE apps SET updated_at = ? WHERE slug = ?").bind(now(), app.slug).run();
  logAppEvent(agent, app.slug, "publish", { target, buildNumber, commit });

  return json(
    {
      ok: true,
      app: app.slug,
      target,
      bundleId: targetRow.bundleId,
      buildNumber,
      buildId: id,
      sourceCommit: commit,
      installPage: `${url.origin}/apps`,
      message: `Build ${buildNumber} of ${target} is live. People install or update it from ${url.origin}/apps on their iPhone.`,
    },
    { status: 201, headers: noStore },
  );
}

class SignError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Signs a stored unsigned build and stores the .ipa. */
async function signBuild(
  env: AppsEnv,
  app: string,
  build: string,
  bundleId: string,
  buildNumber: number,
) {
  const unsigned = await env.SITES.get(unsignedKey(app, build));
  if (!unsigned) throw new SignError("The unsigned build is missing", 500);
  const profile = await signingProfile(env);
  const key = signedKey(app, build, profile.id);
  const signer = env.NAP_SIGNER_URL
    ? { fetch: (request: Request) => fetch(request) }
    : getContainer(env.SIGNER!, "signer");
  const response = await signer.fetch(
    new Request(`${env.NAP_SIGNER_URL || "http://signer"}/sign`, {
      method: "POST",
      body: fixedLength(unsigned.body, unsigned.size),
      headers: {
        "content-type": "application/zip",
        "x-bundle-id": bundleId,
        "x-build-number": String(buildNumber),
        "x-profile": toBase64(profile.bytes),
      },
    }),
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new SignError(
      body.error ?? `Signing failed (${response.status})`,
      response.status === 400 ? 400 : 502,
    );
  }
  const bytes = Number(response.headers.get("content-length"));
  if (!response.body || !Number.isFinite(bytes) || bytes <= 0) {
    throw new SignError("The signer returned no app", 502);
  }
  await env.SITES.put(key, fixedLength(response.body, bytes), {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  const header = (name: string) => {
    const value = response.headers.get(name);
    if (!value) return "";
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
    } catch {
      return "";
    }
  };
  return {
    bytes,
    key,
    profileId: profile.id,
    appName: header("x-app-name").slice(0, 120),
    shortVersion: header("x-app-short-version").slice(0, 40),
    xcode: header("x-app-xcode").slice(0, 20),
  };
}

/**
 * Signs a build again when the profile changed since it was signed (a device was added), so
 * every registered iPhone can install it. Runs when someone asks to install the build.
 */
export async function ensureCurrentSignature(env: AppsEnv, build: BuildRow) {
  const profile = await signingProfile(env);
  if (build.signedProfile === profile.id) return;
  const target = await getTarget(env.DB, build.appSlug, build.target);
  if (!target) return;
  const signed = await signBuild(env, build.appSlug, build.id, target.bundleId, build.buildNumber);
  await env.DB.prepare(
    "UPDATE app_builds SET signed_key = ?, signed_profile = ?, signed_bytes = ? WHERE id = ?",
  )
    .bind(signed.key, signed.profileId, signed.bytes, build.id)
    .run();
}

/** The live build of every target of every app. */
export async function liveBuilds(db: D1Database) {
  const { results } = await db
    .prepare("SELECT live_build AS id FROM app_targets WHERE live_build IS NOT NULL")
    .all<{ id: string }>();
  const builds = await Promise.all(results.map((row) => getBuild(db, row.id)));
  return builds.filter((build): build is BuildRow => build !== null);
}

/** A stream with a known length, which R2 and the container need. */
function fixedLength(body: ReadableStream, length: number) {
  const { readable, writable } = new FixedLengthStream(length);
  void body.pipeTo(writable).catch(() => undefined);
  return readable;
}

// ---- Installing ----

/**
 * An install link for one build: an itms-services URL whose manifest and .ipa are under
 * /_nap/install/<token>/. Access bypasses that path; the token is the credential.
 */
export async function createInstallLink(
  db: D1Database,
  buildId: string,
  email: string,
  origin: string,
) {
  const token = randomString(32);
  const expiresAt = new Date(Date.now() + INSTALL_LINK_SECONDS * 1000).toISOString();
  await db
    .prepare(
      "INSERT INTO app_install_links (token_hash, build_id, email, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(await sha256Hex(token), buildId, email, expiresAt)
    .run();
  await db.prepare("DELETE FROM app_install_links WHERE expires_at < ?").bind(now()).run();
  const manifest = `${origin}${INSTALL_PREFIX}${token}/manifest.plist`;
  return {
    url: `itms-services://?action=download-manifest&url=${encodeURIComponent(manifest)}`,
    expiresAt,
  };
}

export const isInstallPath = (pathname: string) => pathname.startsWith(INSTALL_PREFIX);

/**
 * GET /_nap/install/<token>/manifest.plist and /_nap/install/<token>/app.ipa, for the iOS
 * installer. Never uses getIdentity(): Access bypasses this path.
 */
export async function handleInstallRequest(env: AppsEnv, request: Request) {
  const url = new URL(request.url);
  const match = url.pathname
    .slice(INSTALL_PREFIX.length)
    .match(/^([A-Za-z0-9_-]{43})\/(manifest\.plist|app\.ipa)$/);
  if (!match || (request.method !== "GET" && request.method !== "HEAD")) {
    return new Response("Not found", { status: 404, headers: noStore });
  }
  const [, token, file] = match;
  const link = await env.DB.prepare(
    `SELECT b.id, b.app_slug AS appSlug, b.target, b.build_number AS buildNumber,
            b.app_name AS appName, b.short_version AS shortVersion, b.signed_bytes AS signedBytes,
            b.signed_key AS signedKey,
            t.bundle_id AS bundleId, t.title
     FROM app_install_links l
     JOIN app_builds b ON b.id = l.build_id
     JOIN app_targets t ON t.app_slug = b.app_slug AND t.target = b.target
     WHERE l.token_hash = ? AND l.expires_at > ? AND b.status = 'ready'`,
  )
    .bind(await sha256Hex(token), now())
    .first<{
      id: string;
      appSlug: string;
      target: string;
      buildNumber: number;
      appName: string;
      shortVersion: string;
      signedBytes: number;
      signedKey: string | null;
      bundleId: string;
      title: string;
    }>();
  if (!link)
    return new Response("This install link has expired. Open Nap again.", {
      status: 404,
      headers: noStore,
    });

  if (file === "app.ipa") {
    const object = await env.SITES.get(link.signedKey ?? signedKey(link.appSlug, link.id));
    if (!object) return new Response("Not found", { status: 404, headers: noStore });
    return new Response(request.method === "HEAD" ? null : object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        ...noStore,
      },
    });
  }

  const title = link.appName || link.title || link.target;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key><string>software-package</string>
          <key>url</key><string>${xml(`${url.origin}${INSTALL_PREFIX}${token}/app.ipa`)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>${xml(link.bundleId)}</string>
        <key>bundle-version</key><string>${xml(link.shortVersion || "1.0")}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>${xml(title)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
  return new Response(manifest, {
    headers: { "content-type": "application/xml; charset=utf-8", ...noStore },
  });
}

const xml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!,
  );

// ---- Reading ----

async function getApp(db: D1Database, slug: string) {
  return db.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE slug = ?`).bind(slug).first<AppRow>();
}

async function getTarget(db: D1Database, app: string, target: string) {
  return db
    .prepare(`SELECT ${TARGET_COLUMNS} FROM app_targets WHERE app_slug = ? AND target = ?`)
    .bind(app, target)
    .first<TargetRow>();
}

async function getBuild(db: D1Database, id: string) {
  return db
    .prepare(`SELECT ${BUILD_COLUMNS} FROM app_builds WHERE id = ?`)
    .bind(id)
    .first<BuildRow>();
}

export async function liveBuild(db: D1Database, app: string, target: string) {
  const row = await getTarget(db, app, target);
  return row?.liveBuild ? getBuild(db, row.liveBuild) : null;
}

function describeBuild(build: BuildRow) {
  return {
    id: build.id,
    target: build.target,
    buildNumber: build.buildNumber,
    sourceCommit: build.sourceCommit,
    status: build.status,
    error: build.error,
    notes: build.notes,
    name: build.appName,
    version: build.shortVersion,
    xcode: build.xcode,
    bytes: build.signedBytes,
    by: build.createdByEmail,
    client: build.client,
    createdAt: build.createdAt,
  };
}

async function describeApp(db: D1Database, app: AppRow, _origin: string) {
  const { results: targets } = await db
    .prepare(`SELECT ${TARGET_COLUMNS} FROM app_targets WHERE app_slug = ? ORDER BY target`)
    .bind(app.slug)
    .all<TargetRow>();
  const builds = await Promise.all(
    targets.map((target) => (target.liveBuild ? getBuild(db, target.liveBuild) : null)),
  );
  return {
    slug: app.slug,
    title: app.title,
    createdBy: app.createdByEmail,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    targets: targets.map((target, index) => ({
      target: target.target,
      bundleId: target.bundleId,
      title: target.title || target.target,
      live: builds[index] ? describeBuild(builds[index]!) : null,
    })),
  };
}

/** Every app with its targets and live builds. Everyone who can sign in sees all of them. */
export async function listApps(db: D1Database, origin: string) {
  const { results } = await db
    .prepare(`SELECT ${APP_COLUMNS} FROM apps ORDER BY updated_at DESC LIMIT 200`)
    .all<AppRow>();
  return Promise.all(results.map((app) => describeApp(db, app, origin)));
}

/** For the dashboard: an install link for a target's live build. */
export async function installLiveBuild(
  env: AppsEnv,
  email: string,
  app: string,
  target: string,
  origin: string,
) {
  const live = await liveBuild(env.DB, app, target);
  if (!live) return null;
  await ensureCurrentSignature(env, live);
  return createInstallLink(env.DB, live.id, email, origin);
}

/** An audit line for app events. Never logs tokens. */
function logAppEvent(
  agent: AgentIdentity,
  app: string,
  action: string,
  extra: Record<string, unknown> = {},
) {
  console.log(
    JSON.stringify({
      message: "App event",
      action,
      app,
      email: agent.email,
      client: agent.client,
      tokenId: agent.tokenId,
      ...extra,
    }),
  );
}
