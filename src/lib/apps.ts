import { Effect, Schema } from "effect";
import type { AgentIdentity } from "~/lib/agent-auth";
import { appTemplateFiles } from "~/lib/app-template";
import {
  AppleError,
  buildUploadStatus,
  ensureCapabilities,
  latestTestFlightBuildNumber,
  signingProfile,
  toBase64,
  uploadToTestFlight,
} from "~/lib/apple";
import {
  AUTOMATIC_CAPABILITIES,
  type AutomaticCapability,
  type CapabilityRequests,
  planCapabilities,
  readRequests,
} from "~/lib/capabilities";
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
import { failNoStore, json, noStore, readParams } from "~/server/http";
import { Storage } from "~/server/storage";

/**
 * Native apps. See migrations/0018_apps.sql for the model.
 *
 * A Nap has one app, napConfig.apps.testFlight.app: a launcher with one folder per app inside it.
 *
 * 1. An agent creates the app once: Nap makes its source repo (Artifacts) and returns a Git token.
 * 2. The agent pushes the Xcode project to main, builds the launcher on a Mac without signing, and
 *    uploads the zipped .app with the commit it built: POST /_nap/api/apps/<app>/builds.
 * 3. Nap checks the commit like a site's (head of main, contains the live build's commit), stores
 *    the unsigned build, signs it with the App Store profile in the signer container, and uploads
 *    it to App Store Connect before it goes live. Apple processes it for a few minutes; Nap asks
 *    Apple how far it got when someone looks at the apps.
 *
 * Every person who can sign in can push to and publish the app, and install it from TestFlight.
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
  testflightState: "processing" | "ready" | "failed" | null;
  testflightError: string | null;
  testflightUpload: string | null;
  testflightKey: string | null;
  testflightCheckedAt: string | null;
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
  testflight_state AS testflightState, testflight_error AS testflightError,
  testflight_upload AS testflightUpload, testflight_key AS testflightKey,
  testflight_checked_at AS testflightCheckedAt,
  created_by_email AS createdByEmail, client, created_at AS createdAt`;

/** The one target Nap publishes: the launcher. Builds name it, as older scripts do. */
const LAUNCHER = "launcher";
/** Workers take request bodies up to 100 MB. Launchers are far smaller. */
export const MAX_APP_BYTES = 95 * 1024 * 1024;
const now = () => new Date().toISOString();

export const appsEnabled = () => napConfig.apps !== null;
/** The one app on Nap, and the app record its launcher goes to. Null when apps are off. */
const appConfig = () => napConfig.apps?.testFlight ?? null;
/** The app record, once it exists (appStoreId is set). Null until then, or when apps are off. */
export const testFlightConfig = () => {
  const config = appConfig();
  return config?.appStoreId ? { ...config, appStoreId: config.appStoreId } : null;
};
/** Opens the app in the TestFlight app on an iPhone. */
export const testFlightUrl = (appStoreId: string) =>
  `itms-beta://beta.itunes.apple.com/v1/app/${appStoreId}`;
/** How often Nap asks Apple about a build that is still processing. */
const TESTFLIGHT_CHECK_MS = 10 * 1000;

const unsignedKey = (app: string, build: string) => `apps/${app}/builds/${build}/unsigned.zip`;
/** The .ipa signed for the App Store (TestFlight), named after its profile. */
const signedKey = (app: string, build: string, profile: string) =>
  `apps/${app}/builds/${build}/signed-appstore-${profile}.ipa`;

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
  // The live build of the launcher.
  const targetMatch = rest.match(/^\/targets\/([a-z][a-z0-9-]{0,31})$/);
  if (targetMatch && method === "GET") {
    const live = yield* liveBuild(app.slug, targetMatch[1]);
    if (!live) {
      return yield* failNoStore(404, "This target has no live build", { code: "no_live_build" });
    }
    return json({ build: describeBuild(live) }, { headers: noStore });
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
  const testFlight = appConfig();
  if (testFlight && slug !== testFlight.app) {
    return yield* failNoStore(
      409,
      `This Nap has one app, ${testFlight.app}, which goes to TestFlight. Add yours to its launcher: node nap-publish.mjs app clone ${testFlight.app}`,
      { code: "one_app" },
    );
  }
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
      next: "Start from the template (GET /_nap/api/apps/template), push it to main, then build the launcher and POST it to /_nap/api/apps/<slug>/builds.",
    },
    { status: 201, headers: noStore },
  );
});

/**
 * POST /_nap/api/apps/<app>/builds?target=launcher&sourceCommit=<sha>&notes=<text>
 * Body: a zip of the unsigned .app (content-type application/zip).
 */
const publishBuild = Effect.fnUntraced(function* (
  request: Request,
  url: URL,
  agent: AgentIdentity,
  app: AppRow,
) {
  const target = (url.searchParams.get("target") ?? "").trim() || LAUNCHER;
  const commit = (url.searchParams.get("sourceCommit") ?? "").trim().toLowerCase();
  const notes = (url.searchParams.get("notes") ?? "").trim().slice(0, 2000);
  const testFlight = appConfig()!;
  if (app.slug !== testFlight.app || target !== LAUNCHER) {
    return yield* failNoStore(
      400,
      `This Nap only publishes the launcher of ${testFlight.app}, to TestFlight. Add your app to that launcher and publish the launcher.`,
      { code: "not_distributed" },
    );
  }
  if (!testFlightConfig()) {
    return yield* failNoStore(
      503,
      `The app record in App Store Connect is not set up yet, so ${testFlight.app} cannot be published. Ask ${napConfig.admin}.`,
      { code: "testflight_unavailable" },
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

  let targetRow = yield* getTarget(app.slug, target);
  const live = targetRow?.liveBuild ? yield* getBuild(targetRow.liveBuild) : null;
  yield* checkRepoCommit(app.sourceRepo, commit, live?.sourceCommit ?? null);

  if (!targetRow) {
    yield* db.run(
      `INSERT INTO app_targets (app_slug, target, bundle_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      app.slug,
      target,
      testFlight.bundleId,
    );
    targetRow = yield* getTarget(app.slug, target);
    if (!targetRow) return yield* failNoStore(500, "Could not add the launcher");
  }

  // Build numbers must go above every build App Store Connect has, from any source.
  const latest = yield* latestTestFlightBuildNumber().pipe(
    Effect.catchTag("AppleError", (error) =>
      failNoStore(503, error.message, { code: "testflight_unavailable" }),
    ),
  );
  yield* db.run(
    `UPDATE app_targets SET next_build_number = MAX(next_build_number, ?)
     WHERE app_slug = ? AND target = ?`,
    latest + 1,
    app.slug,
    target,
  );
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

  yield* storage.put(unsignedKey(app.slug, id), fixedLength(body, size), {
    httpMetadata: { contentType: "application/zip" },
  });

  const catchSigning = Effect.catchTags({
    SignError: (error: SignError) => failBuild(error.status, error.message),
    AppleError: (error: AppleError) => failBuild(503, error.message),
  });

  // Sign for the App Store and upload before going live, so a build Apple refuses never does.
  const signed = yield* signBuild(app.slug, id, testFlight.bundleId, buildNumber).pipe(
    catchSigning,
  );
  const upload = yield* uploadToTestFlight(signed.key, signed.shortVersion, buildNumber).pipe(
    Effect.catchTag("AppleError", (error) =>
      failBuild(502, `Uploading to TestFlight failed: ${error.message}`),
    ),
  );
  yield* db.run(
    `UPDATE app_builds SET status = 'ready', app_name = ?, short_version = ?, xcode = ?,
                           signed_bytes = ?, testflight_state = 'processing',
                           testflight_upload = ?, testflight_key = ?, testflight_checked_at = ?
     WHERE id = ?`,
    signed.appName,
    signed.shortVersion,
    signed.xcode,
    signed.bytes,
    upload,
    signed.key,
    now(),
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

  const page = `${url.origin}/apps`;
  const message = [
    `Build ${buildNumber} of ${target} is uploaded to TestFlight. Apple processes it for a few minutes; then testers install or update it in the TestFlight app. ${page} shows when it is ready.`,
    capabilityNote(signed),
  ]
    .filter(Boolean)
    .join(" ");
  return json(
    {
      ok: true,
      app: app.slug,
      target,
      bundleId: testFlight.bundleId,
      buildNumber,
      buildId: id,
      sourceCommit: commit,
      installPage: page,
      testFlight: { state: "processing" },
      capabilities: signed.capabilities,
      capabilityWarnings: signed.capabilityWarnings,
      message,
    },
    { status: 201, headers: noStore },
  );
});

/** For the publish message: what the build may not use, which the launcher also shows. */
function capabilityNote(signed: Signed) {
  const lines = Object.entries(signed.capabilityWarnings).flatMap(([slug, warnings]) =>
    warnings.map((warning) => `${slug}: ${warning}`),
  );
  return lines.length
    ? `Capabilities the build does not get (the launcher shows these on the app): ${lines.join(" ")}`
    : "";
}

/** Signing a build failed. `status` is the status the agent gets for a new build. */
class SignError extends Schema.TaggedError<SignError>()("SignError", {
  message: Schema.String,
  status: Schema.Number,
}) {}

type Signed = Effect.Success<ReturnType<typeof signBuild>>;

/** Signs a stored unsigned build for the App Store and stores the .ipa. */
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
  const signer = yield* SignerBinding;
  if (!signer) {
    return yield* new SignError({ message: "The app signer is not set up", status: 503 });
  }
  // Capabilities first: turning one on makes a new App Store profile, which signing then uses.
  const requests = yield* inspectBuild(signer, unsigned.body, unsigned.size);
  const capabilities = yield* grantCapabilities(requests);
  // App Store profiles change with capabilities, from any Nap that shares the App ID, and
  // publishes are rare: ask Apple each time.
  const profile = yield* signingProfile({ fresh: true });
  const key = signedKey(app, build, profile.id);
  const fresh = yield* storage.get(unsignedKey(app, build));
  if (!fresh) {
    return yield* new SignError({ message: "The unsigned build is missing", status: 500 });
  }
  const response = yield* Effect.promise(() =>
    signer.fetch(
      new Request(`${signer.url}/sign`, {
        method: "POST",
        body: fixedLength(fresh.body, fresh.size),
        headers: {
          "content-type": "application/zip",
          "x-bundle-id": bundleId,
          "x-build-number": String(buildNumber),
          "x-profile": toBase64(profile.bytes),
          "x-distribution": "app-store",
          "x-entitlement-keys": capabilities.entitlementKeys.join(","),
          ...(Object.keys(capabilities.warnings).length
            ? {
                "x-warnings": toBase64(
                  new TextEncoder().encode(JSON.stringify(capabilities.warnings)),
                ),
              }
            : {}),
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
    capabilities: capabilities.granted,
    capabilityWarnings: capabilities.warnings,
  };
});

/** What a build asks for: the NapCapabilities key in its Info.plist, read by the signer. */
const inspectBuild = Effect.fnUntraced(function* (
  signer: NonNullable<Effect.Success<typeof SignerBinding>>,
  body: ReadableStream,
  size: number,
) {
  const response = yield* Effect.promise(() =>
    signer.fetch(
      new Request(`${signer.url}/inspect`, {
        method: "POST",
        body: fixedLength(body, size),
        headers: { "content-type": "application/zip" },
      }),
    ),
  );
  const result = (yield* Effect.promise(() => response.json().catch(() => ({})))) as {
    capabilities?: unknown;
    error?: string;
  };
  // A signer from before /inspect, while a new one rolls out: the build asks for nothing.
  if (response.status === 404) {
    yield* Effect.logWarning("The signer cannot inspect builds yet");
    return {};
  }
  if (!response.ok) {
    return yield* new SignError({
      message: String(result.error ?? `Reading the build failed (${response.status})`),
      status: response.status === 400 ? 400 : 502,
    });
  }
  return readRequests(result.capabilities);
});

/** Turns on what a build asks for and can have, for the App ID, and says what it cannot. */
const grantCapabilities = Effect.fnUntraced(function* (requests: CapabilityRequests) {
  const allowed = napConfig.apps?.testFlight?.capabilities;
  const refuse = (name: AutomaticCapability) => {
    if (allowed && !allowed.includes(name)) {
      return "is not on this Nap's list of capabilities. Ask whoever runs Nap to add it";
    }
    return null;
  };
  const plan = planCapabilities(requests, refuse);
  if (plan.granted.length === 0) return plan;
  const refused = yield* ensureCapabilities(
    plan.granted.map((name) => AUTOMATIC_CAPABILITIES[name].apple),
  );
  if (refused.size === 0) return plan;
  // Apple would not turn some on: warn about those instead.
  return planCapabilities(requests, (name) => {
    const reason = refuse(name);
    if (reason) return reason;
    const apple = refused.get(AUTOMATIC_CAPABILITIES[name].apple);
    return apple ? `could not be turned on: ${apple}` : null;
  });
});

/** A stream with a known length, which R2 and the container need. */
function fixedLength(body: ReadableStream, length: number) {
  const { readable, writable } = new FixedLengthStream(length);
  void body.pipeTo(writable).catch(() => undefined);
  return readable;
}

/**
 * A build that Apple is still processing, with the latest word from App Store Connect. Asks Apple
 * at most every few seconds per build, however many people are looking; a failed check leaves
 * the build as it was.
 */
const refreshTestFlight = Effect.fnUntraced(function* (build: BuildRow) {
  if (build.testflightState !== "processing" || !build.testflightUpload) return build;
  const db = yield* Database;
  const checkedAt = now();
  const claimed = yield* db.run(
    `UPDATE app_builds SET testflight_checked_at = ?
     WHERE id = ? AND testflight_state = 'processing'
       AND (testflight_checked_at IS NULL OR testflight_checked_at < ?)`,
    checkedAt,
    build.id,
    new Date(Date.now() - TESTFLIGHT_CHECK_MS).toISOString(),
  );
  if (claimed.changes !== 1) return build;
  const status = yield* buildUploadStatus(build.testflightUpload).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("TestFlight status check failed").pipe(
        Effect.annotateLogs({ build: build.id, cause: String(cause) }),
        Effect.as(null),
      ),
    ),
  );
  if (!status || status.state === "processing") return build;
  const error = status.state === "failed" ? status.error : null;
  yield* db.run(
    "UPDATE app_builds SET testflight_state = ?, testflight_error = ? WHERE id = ?",
    status.state,
    error,
    build.id,
  );
  yield* Effect.logInfo("TestFlight build processed").pipe(
    Effect.annotateLogs({ build: build.id, state: status.state, error }),
  );
  return { ...build, testflightState: status.state, testflightError: error };
});

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

/**
 * The TestFlight launcher's live build, with Apple's latest word on processing: what the
 * dashboard's Get the app shows. Null when TestFlight is off or nothing was published yet.
 */
export const testFlightBuild = Effect.fn("testFlightBuild")(function* () {
  const testFlight = testFlightConfig();
  if (!testFlight) return null;
  const build = yield* liveBuild(testFlight.app, LAUNCHER);
  if (!build) return null;
  const fresh = yield* refreshTestFlight(build);
  return {
    buildNumber: fresh.buildNumber,
    name: fresh.appName,
    state: fresh.testflightState,
    error: fresh.testflightError,
  };
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
    testFlight: build.testflightState
      ? { state: build.testflightState, error: build.testflightError }
      : null,
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
    (target) =>
      target.liveBuild
        ? getBuild(target.liveBuild).pipe(
            Effect.flatMap((build) => (build ? refreshTestFlight(build) : Effect.succeed(null))),
          )
        : Effect.succeed(null),
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
      bundleId: appConfig()?.bundleId ?? target.bundleId,
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
