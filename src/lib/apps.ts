import { Effect, Schema } from "effect";
import type { AgentIdentity } from "~/lib/agent-auth";
import { appTemplateFiles } from "~/lib/app-template";
import { bundleIdFor, signingProfile, toBase64 } from "~/lib/apple";
import { slugify } from "~/lib/nap-server";
import {
  checkRepoCommit,
  containsCommit,
  createNamedRepo,
  deleteSourceRepo,
  mintSourceToken,
  repoHead,
} from "~/lib/sources";
import { napConfig } from "~/nap.config";
import { SignerBinding } from "~/server/bindings";
import { Database } from "~/server/database";
import { failNoStore, failText, json, noStore, readParams } from "~/server/http";
import { Storage } from "~/server/storage";
import { randomString, sha256Hex } from "~/server/tokens";

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
const now = () => new Date().toISOString();

export const appsEnabled = () => napConfig.apps !== null;

const unsignedKey = (app: string, build: string) => `apps/${app}/builds/${build}/unsigned.zip`;
/** Builds signed before re-signing existed are at signed.ipa; later ones name their profile. */
const signedKey = (app: string, build: string, profile?: string) =>
  `apps/${app}/builds/${build}/${profile ? `signed-${profile}` : "signed"}.ipa`;

/** The agent API under /_nap/api/apps. `path` starts after /apps. */
export const handleAppsApi = Effect.fn("handleAppsApi")(function* (
  request: Request,
  url: URL,
  agent: AgentIdentity,
  path: string,
) {
  if (!appsEnabled())
    return yield* failNoStore(404, "Apps are off on this Nap", { code: "apps_off" });
  const method = request.method;
  const db = yield* Database;

  if (path === "" && method === "GET") {
    return json({ apps: yield* listApps(url.origin) }, { headers: noStore });
  }
  if (path === "" && method === "POST") {
    const params = yield* readParams(request, url);
    return yield* createApp(agent, params.slug ?? "", params.title ?? "");
  }
  if (path === "/template" && method === "GET") {
    return json({ files: appTemplateFiles() }, { headers: noStore });
  }

  const match = path.match(/^\/([a-z0-9-]{1,32})(\/.*)?$/);
  if (!match) return yield* failNoStore(404, "Not found");
  const app = yield* getApp(match[1]);
  if (!app) return yield* failNoStore(404, "App not found");
  const rest = match[2] ?? "";

  if (rest === "" && method === "GET") {
    const source = yield* repoHead(app.sourceRepo);
    return json({ app: yield* describeApp(app, url.origin), source }, { headers: noStore });
  }
  if (rest === "/source/token" && method === "POST") {
    const params = yield* readParams(request, url);
    const scope = params.access ?? "write";
    if (scope !== "read" && scope !== "write") {
      return yield* failNoStore(400, 'access must be "read" or "write"');
    }
    const access = yield* mintSourceToken(app.sourceRepo, scope);
    yield* logAppEvent(agent, app.slug, `source-${scope}`);
    return json({ source: access }, { headers: noStore });
  }
  if (rest === "/builds" && method === "POST") {
    return yield* publishBuild(request, url, agent, app);
  }
  if (rest === "/builds" && method === "GET") {
    const results = yield* db.all<BuildRow>(
      `SELECT ${BUILD_COLUMNS} FROM app_builds WHERE app_slug = ? ORDER BY created_at DESC LIMIT 50`,
      app.slug,
    );
    return json({ builds: results.map(describeBuild) }, { headers: noStore });
  }
  // The live build of a target, with a fresh install link. Apps call this to check for updates.
  const targetMatch = rest.match(/^\/targets\/([a-z][a-z0-9-]{0,31})$/);
  if (targetMatch && method === "GET") {
    const live = yield* liveBuild(app.slug, targetMatch[1]);
    if (!live) {
      return yield* failNoStore(404, "This target has no live build", { code: "no_live_build" });
    }
    yield* ensureCurrentSignature(live);
    const install = yield* createInstallLink(live.id, agent.email, url.origin);
    return json({ build: describeBuild(live), install }, { headers: noStore });
  }
  return yield* failNoStore(404, "Not found");
});

const createApp = Effect.fnUntraced(function* (
  agent: AgentIdentity,
  rawSlug: string,
  rawTitle: string,
) {
  const slug = slugify(rawSlug);
  if (!slug) {
    return yield* failNoStore(400, "slug is required: lowercase letters, numbers, and hyphens");
  }
  const title = rawTitle.trim().slice(0, 120) || slug;
  if (yield* getApp(slug)) {
    return yield* failNoStore(409, `The app ${slug} already exists. Clone it instead.`, {
      code: "app_exists",
    });
  }
  const repo = yield* createNamedRepo(`app-${slug}`, title);
  const db = yield* Database;
  const inserted = yield* db.run(
    `INSERT INTO apps (slug, title, source_repo, created_by_email) VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    slug,
    title,
    repo,
    agent.email,
  );
  if (inserted.changes !== 1) {
    yield* deleteSourceRepo(repo);
    return yield* failNoStore(409, `The app ${slug} already exists. Clone it instead.`, {
      code: "app_exists",
    });
  }
  const access = yield* mintSourceToken(repo, "write");
  yield* logAppEvent(agent, slug, "create");
  return json(
    {
      app: { slug, title },
      source: access,
      next: "Start from the template (GET /_nap/api/apps/template), push it to main, then build a target and POST it to /_nap/api/apps/<slug>/builds.",
    },
    { status: 201, headers: noStore },
  );
});

/**
 * POST /_nap/api/apps/<app>/builds?target=<target>&sourceCommit=<sha>&notes=<text>
 * Body: a zip of the unsigned .app (content-type application/zip).
 */
const publishBuild = Effect.fnUntraced(function* (
  request: Request,
  url: URL,
  agent: AgentIdentity,
  app: AppRow,
) {
  const target = (url.searchParams.get("target") ?? "").trim();
  const commit = (url.searchParams.get("sourceCommit") ?? "").trim().toLowerCase();
  const notes = (url.searchParams.get("notes") ?? "").trim().slice(0, 2000);
  if (!TARGET_PATTERN.test(target)) {
    return yield* failNoStore(
      400,
      "target must start with a letter and use lowercase letters, numbers, and hyphens",
    );
  }
  const size = Number(request.headers.get("content-length"));
  const body = request.body;
  if (!body || !Number.isFinite(size) || size <= 0) {
    return yield* failNoStore(411, "Send the zipped .app as the body, with a content-length");
  }
  if (size > MAX_APP_BYTES) return yield* failNoStore(413, "The app is larger than 95 MB");
  if (!(yield* SignerBinding)) {
    return yield* failNoStore(503, "The app signer is not set up", { code: "signer_unavailable" });
  }
  const db = yield* Database;
  const storage = yield* Storage;

  // The target: new targets get their bundle id now, so a name cannot be taken twice.
  let targetRow = yield* getTarget(app.slug, target);
  if (!targetRow) {
    const bundleId = bundleIdFor(target);
    const taken = yield* db.first<{ appSlug: string }>(
      `SELECT app_slug AS appSlug FROM app_targets WHERE bundle_id = ?`,
      bundleId,
    );
    if (taken) {
      return yield* failNoStore(
        409,
        `The target name ${target} is used by the app ${taken.appSlug}. Pick another.`,
        {
          code: "target_taken",
        },
      );
    }
  }
  const live = targetRow?.liveBuild ? yield* getBuild(targetRow.liveBuild) : null;
  yield* checkRepoCommit(app.sourceRepo, commit, live?.sourceCommit ?? null);

  if (!targetRow) {
    yield* db.run(
      `INSERT INTO app_targets (app_slug, target, bundle_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      app.slug,
      target,
      bundleIdFor(target),
    );
    targetRow = yield* getTarget(app.slug, target);
    if (!targetRow) {
      return yield* failNoStore(409, `The target name ${target} is taken. Pick another.`);
    }
  }

  const numbered = yield* db.first<{ buildNumber: number }>(
    `UPDATE app_targets SET next_build_number = next_build_number + 1
     WHERE app_slug = ? AND target = ? RETURNING next_build_number - 1 AS buildNumber`,
    app.slug,
    target,
  );
  const buildNumber = numbered!.buildNumber;
  const id = crypto.randomUUID();
  yield* db.run(
    `INSERT INTO app_builds (id, app_slug, target, build_number, source_commit, status, notes,
                             unsigned_bytes, created_by_email, client)
     VALUES (?, ?, ?, ?, ?, 'signing', ?, ?, ?, ?)`,
    id,
    app.slug,
    target,
    buildNumber,
    commit,
    notes,
    size,
    agent.email,
    agent.client.slice(0, 80),
  );

  const failBuild = (status: number, error: string) =>
    db
      .run("UPDATE app_builds SET status = 'failed', error = ? WHERE id = ?", error, id)
      .pipe(Effect.andThen(failNoStore(status, error, { code: "build_failed", buildId: id })));

  // Keep the unsigned build: a new device means signing it again, not building it again.
  yield* storage.put(unsignedKey(app.slug, id), fixedLength(body, size), {
    httpMetadata: { contentType: "application/zip" },
  });

  const signed = yield* signBuild(app.slug, id, targetRow.bundleId, buildNumber).pipe(
    Effect.catchTags({
      SignError: (error) => failBuild(error.status, error.message),
      AppleError: (error) => failBuild(503, error.message),
    }),
  );
  yield* db.run(
    `UPDATE app_builds SET status = 'ready', app_name = ?, short_version = ?, xcode = ?,
                           signed_bytes = ?, signed_key = ?, signed_profile = ?
     WHERE id = ?`,
    signed.appName,
    signed.shortVersion,
    signed.xcode,
    signed.bytes,
    signed.key,
    signed.profileId,
    id,
  );

  // Go live, unless another build of this target went live meanwhile with commits this one lacks.
  let previous = targetRow.liveBuild;
  for (let attempt = 0; attempt < 3; attempt++) {
    const moved = yield* db.run(
      `UPDATE app_targets SET live_build = ?1, title = ?2, updated_at = ?3
       WHERE app_slug = ?4 AND target = ?5 AND live_build IS ?6`,
      id,
      signed.appName || targetRow.title,
      now(),
      app.slug,
      target,
      previous,
    );
    if (moved.changes === 1) break;
    const current = yield* getTarget(app.slug, target);
    const currentBuild = current?.liveBuild ? yield* getBuild(current.liveBuild) : null;
    if (
      currentBuild &&
      !(yield* containsCommit(app.sourceRepo, commit, currentBuild.sourceCommit))
    ) {
      return yield* failNoStore(
        409,
        `Build ${currentBuild.buildNumber} of ${target} went live while this one was signing, and this build does not contain its commit. Pull, build again, and publish.`,
        { code: "source_not_descendant", buildId: id },
      );
    }
    previous = current?.liveBuild ?? null;
  }
  yield* db.run("UPDATE apps SET updated_at = ? WHERE slug = ?", now(), app.slug);
  yield* logAppEvent(agent, app.slug, "publish", { target, buildNumber, commit });

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
});

/** Signing a build failed. `status` is the status the agent gets for a new build. */
class SignError extends Schema.TaggedError<SignError>()("SignError", {
  message: Schema.String,
  status: Schema.Number,
}) {}

/** Signs a stored unsigned build and stores the .ipa. */
const signBuild = Effect.fnUntraced(function* (
  app: string,
  build: string,
  bundleId: string,
  buildNumber: number,
) {
  const storage = yield* Storage;
  const unsigned = yield* storage.get(unsignedKey(app, build));
  if (!unsigned) {
    return yield* new SignError({ message: "The unsigned build is missing", status: 500 });
  }
  const profile = yield* signingProfile();
  const key = signedKey(app, build, profile.id);
  const signer = yield* SignerBinding;
  if (!signer) {
    return yield* new SignError({ message: "The app signer is not set up", status: 503 });
  }
  const response = yield* Effect.promise(() =>
    signer.fetch(
      new Request(`${signer.url}/sign`, {
        method: "POST",
        body: fixedLength(unsigned.body, unsigned.size),
        headers: {
          "content-type": "application/zip",
          "x-bundle-id": bundleId,
          "x-build-number": String(buildNumber),
          "x-profile": toBase64(profile.bytes),
        },
      }),
    ),
  );
  if (!response.ok) {
    const body = (yield* Effect.promise(() => response.json().catch(() => ({})))) as {
      error?: string;
    };
    return yield* new SignError({
      message: String(body.error ?? `Signing failed (${response.status})`),
      status: response.status === 400 ? 400 : 502,
    });
  }
  const bytes = Number(response.headers.get("content-length"));
  if (!response.body || !Number.isFinite(bytes) || bytes <= 0) {
    return yield* new SignError({ message: "The signer returned no app", status: 502 });
  }
  yield* storage.put(key, fixedLength(response.body, bytes), {
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
});

/**
 * Signs a build again when the profile changed since it was signed (a device was added), so
 * every registered iPhone can install it. Runs when someone asks to install the build.
 */
export const ensureCurrentSignature = Effect.fn("ensureCurrentSignature")(function* (
  build: BuildRow,
) {
  const profile = yield* signingProfile();
  if (build.signedProfile === profile.id) return;
  const target = yield* getTarget(build.appSlug, build.target);
  if (!target) return;
  const signed = yield* signBuild(build.appSlug, build.id, target.bundleId, build.buildNumber);
  const db = yield* Database;
  yield* db.run(
    "UPDATE app_builds SET signed_key = ?, signed_profile = ?, signed_bytes = ? WHERE id = ?",
    signed.key,
    signed.profileId,
    signed.bytes,
    build.id,
  );
});

/** The live build of every target of every app. */
export const liveBuilds = Effect.gen(function* () {
  const db = yield* Database;
  const results = yield* db.all<{ id: string }>(
    "SELECT live_build AS id FROM app_targets WHERE live_build IS NOT NULL",
  );
  const builds = yield* Effect.forEach(results, (row) => getBuild(row.id), {
    concurrency: "unbounded",
  });
  return builds.filter((build): build is BuildRow => build !== null);
});

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
export const createInstallLink = Effect.fn("createInstallLink")(function* (
  buildId: string,
  email: string,
  origin: string,
) {
  const db = yield* Database;
  const token = randomString(32);
  const expiresAt = new Date(Date.now() + INSTALL_LINK_SECONDS * 1000).toISOString();
  yield* db.run(
    "INSERT INTO app_install_links (token_hash, build_id, email, expires_at) VALUES (?, ?, ?, ?)",
    yield* sha256Hex(token),
    buildId,
    email,
    expiresAt,
  );
  yield* db.run("DELETE FROM app_install_links WHERE expires_at < ?", now());
  const manifest = `${origin}${INSTALL_PREFIX}${token}/manifest.plist`;
  return {
    url: `itms-services://?action=download-manifest&url=${encodeURIComponent(manifest)}`,
    expiresAt,
  };
});

export const isInstallPath = (pathname: string) => pathname.startsWith(INSTALL_PREFIX);

/**
 * GET /_nap/install/<token>/manifest.plist and /_nap/install/<token>/app.ipa, for the iOS
 * installer. Never uses getIdentity(): Access bypasses this path.
 */
export const handleInstallRequest = Effect.fn("handleInstallRequest")(function* (request: Request) {
  const url = new URL(request.url);
  const match = url.pathname
    .slice(INSTALL_PREFIX.length)
    .match(/^([A-Za-z0-9_-]{43})\/(manifest\.plist|app\.ipa)$/);
  if (!match || (request.method !== "GET" && request.method !== "HEAD")) {
    return yield* failText(404, "Not found", noStore);
  }
  const [, token, file] = match;
  const db = yield* Database;
  const link = yield* db.first<{
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
  }>(
    `SELECT b.id, b.app_slug AS appSlug, b.target, b.build_number AS buildNumber,
            b.app_name AS appName, b.short_version AS shortVersion, b.signed_bytes AS signedBytes,
            b.signed_key AS signedKey,
            t.bundle_id AS bundleId, t.title
     FROM app_install_links l
     JOIN app_builds b ON b.id = l.build_id
     JOIN app_targets t ON t.app_slug = b.app_slug AND t.target = b.target
     WHERE l.token_hash = ? AND l.expires_at > ? AND b.status = 'ready'`,
    yield* sha256Hex(token),
    now(),
  );
  if (!link) return yield* failText(404, "This install link has expired. Open Nap again.", noStore);

  if (file === "app.ipa") {
    const storage = yield* Storage;
    const object = yield* storage.get(link.signedKey ?? signedKey(link.appSlug, link.id));
    if (!object) return yield* failText(404, "Not found", noStore);
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
});

const xml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!,
  );

// ---- Reading ----

const getApp = Effect.fnUntraced(function* (slug: string) {
  const db = yield* Database;
  return yield* db.first<AppRow>(`SELECT ${APP_COLUMNS} FROM apps WHERE slug = ?`, slug);
});

const getTarget = Effect.fnUntraced(function* (app: string, target: string) {
  const db = yield* Database;
  return yield* db.first<TargetRow>(
    `SELECT ${TARGET_COLUMNS} FROM app_targets WHERE app_slug = ? AND target = ?`,
    app,
    target,
  );
});

const getBuild = Effect.fnUntraced(function* (id: string) {
  const db = yield* Database;
  return yield* db.first<BuildRow>(`SELECT ${BUILD_COLUMNS} FROM app_builds WHERE id = ?`, id);
});

export const liveBuild = Effect.fn("liveBuild")(function* (app: string, target: string) {
  const row = yield* getTarget(app, target);
  return row?.liveBuild ? yield* getBuild(row.liveBuild) : null;
});

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

const describeApp = Effect.fnUntraced(function* (app: AppRow, _origin: string) {
  const db = yield* Database;
  const targets = yield* db.all<TargetRow>(
    `SELECT ${TARGET_COLUMNS} FROM app_targets WHERE app_slug = ? ORDER BY target`,
    app.slug,
  );
  const builds = yield* Effect.forEach(
    targets,
    (target) => (target.liveBuild ? getBuild(target.liveBuild) : Effect.succeed(null)),
    { concurrency: "unbounded" },
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
});

/** An app with its targets and live builds, as listApps returns them. */
export type App = Effect.Success<ReturnType<typeof describeApp>>;

/** Every app with its targets and live builds. Everyone who can sign in sees all of them. */
export const listApps = Effect.fn("listApps")(function* (origin: string) {
  const db = yield* Database;
  const results = yield* db.all<AppRow>(
    `SELECT ${APP_COLUMNS} FROM apps ORDER BY updated_at DESC LIMIT 200`,
  );
  return yield* Effect.forEach(results, (app) => describeApp(app, origin), {
    concurrency: "unbounded",
  });
});

/** For the dashboard: an install link for a target's live build. */
export const installLiveBuild = Effect.fn("installLiveBuild")(function* (
  email: string,
  app: string,
  target: string,
  origin: string,
) {
  const live = yield* liveBuild(app, target);
  if (!live) return null;
  yield* ensureCurrentSignature(live);
  return yield* createInstallLink(live.id, email, origin);
});

/** An audit line for app events. Never logs tokens. */
const logAppEvent = (
  agent: AgentIdentity,
  app: string,
  action: string,
  extra: Record<string, unknown> = {},
) =>
  Effect.logInfo("App event").pipe(
    Effect.annotateLogs({
      action,
      app,
      email: agent.email,
      client: agent.client,
      tokenId: agent.tokenId,
      ...extra,
    }),
  );
