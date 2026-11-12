import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

// Like apps-remarkable.test.mjs: apps.ts reaches the Workers runtime and Vite-only imports.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export const env = {}; export class DurableObject {}",
        shortCircuit: true,
      };
    }
    if (specifier === "~/lib/app-template") {
      return {
        url: `data:text/javascript,export const appTemplateFiles = () => [];`,
        shortCircuit: true,
      };
    }
    if (specifier === "~/nap.config") {
      return next(new URL("../nap.config.ts", import.meta.url).href, context);
    }
    if (specifier.startsWith("~/")) {
      return next(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});

globalThis.FixedLengthStream ??= class extends TransformStream {
  constructor(length) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== length) controller.error(new Error(`Expected ${length} bytes, got ${seen}`));
      },
    });
  }
};

// Workers send streams as request bodies without asking; Node wants duplex: "half".
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input, init) {
    super(input, init?.body instanceof ReadableStream ? { ...init, duplex: "half" } : init);
  }
};

const { napConfig } = await import("../nap.config.ts");
const { handleAppsApi } = await import("../src/lib/apps.ts");
const { respond } = await import("../src/server/runtime.ts");

const AGENT = { email: "owner@example.com", name: "", tokenId: "t1", client: "Test agent" };
const ORIGIN = "https://nap.example.com";
const PACKAGE = "com.example.nap";
const sha = (n) => n.toString(16).padStart(40, "0");

function d1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => {
      const result = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  return { prepare: (sql) => statement(sql) };
}

/** Artifacts with one linear main branch per repo. */
function artifacts() {
  const repos = new Map();
  const handle = (name) => {
    const repo = repos.get(name);
    return {
      info: async () => ({
        name,
        remote: `https://acct.artifacts.cloudflare.net/git/s/${name}.git`,
      }),
      createToken: async (scope, ttl) => ({
        plaintext: `art_${scope}`,
        expiresAt: new Date(ttl * 1000).toISOString(),
      }),
      async log({ ref = "main", limit = 50 } = {}) {
        let hash = ref === "main" ? repo.main : ref;
        const line = [];
        while (hash && repo.commits.has(hash) && line.length < limit) {
          line.push({ hash, parents: repo.commits.get(hash) });
          hash = repo.commits.get(hash)[0];
        }
        return line;
      },
      readCommit: async (hash) =>
        repo.commits.has(hash) ? { hash, parents: repo.commits.get(hash) } : null,
    };
  };
  return {
    async create(name) {
      repos.set(name, { commits: new Map(), main: null });
      return { name, token: "art_initial" };
    },
    get: async (name) => handle(name),
    delete: async (name) => repos.delete(name),
    commit(name, hash, parents = []) {
      const repo = repos.get(name);
      repo.commits.set(hash, parents);
      repo.main = hash;
    },
  };
}

function bucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, options) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, options });
      return { key, size: bytes.byteLength };
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return { body: new Response(object.bytes).body, size: object.bytes.byteLength };
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength } : null;
    },
    async list({ prefix }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
      return {
        objects: keys.map((key) => ({ key, size: objects.get(key).bytes.byteLength })),
        truncated: false,
      };
    },
    async delete(keys) {
      for (const key of [keys].flat()) objects.delete(key);
    },
  };
}

/** The signer container: answers /sign-android with "signed:<package>:<version code>:<body>". */
function signer() {
  const calls = [];
  const stub = {
    async fetch(request) {
      const url = new URL(request.url);
      const body = new Uint8Array(await request.arrayBuffer());
      calls.push({ path: url.pathname, headers: Object.fromEntries(request.headers), body });
      if (url.pathname !== "/sign-android")
        return Response.json({ error: "Not found" }, { status: 404 });
      if (new TextDecoder().decode(body) === "debuggable") {
        return Response.json({ error: "The bundle is debuggable." }, { status: 400 });
      }
      const signed = new TextEncoder().encode(
        `signed:${request.headers.get("x-package-name")}:${request.headers.get("x-build-number")}:${new TextDecoder().decode(body)}`,
      );
      return new Response(signed, {
        headers: {
          "content-length": String(signed.byteLength),
          "x-app-short-version": btoa("1.0"),
        },
      });
    },
  };
  return { calls, binding: { idFromName: () => "signer", get: () => stub } };
}

const serviceAccount = () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({
    client_email: "nap@project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
};

/**
 * Google: OAuth and the Play Developer API, in memory. `bundles` are the version codes Play has;
 * `draftApp` makes Play refuse completed releases; `unknown` answers 404 for the app.
 */
function google({ bundles = [], draftApp = false, unknown = false } = {}) {
  const requests = [];
  const edits = new Map();
  let next = 1;
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "ya29" });
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer ya29");
    const path = url.pathname.replace(/^(\/upload)?\/androidpublisher\/v3\/applications\//, "");
    const [pkg, , edit, kind] = path.split("/");
    if (unknown)
      return Response.json({ error: { message: "Package not found: " + pkg } }, { status: 404 });
    assert.equal(pkg, PACKAGE);
    if (path === `${PACKAGE}/edits` && method === "POST") {
      const id = String(next++);
      edits.set(id, { bundles: [], track: null });
      return Response.json({ id });
    }
    const state = edits.get(edit?.replace(":commit", ""));
    if (!state) return Response.json({ error: { message: "No edit" } }, { status: 400 });
    if (method === "DELETE") {
      edits.delete(edit);
      return new Response(null, { status: 204 });
    }
    if (edit.endsWith(":commit")) {
      if (draftApp && state.track.releases[0].status !== "draft") {
        edits.delete(edit.replace(":commit", ""));
        return Response.json(
          { error: { message: "Only releases with status draft may be created on draft app." } },
          { status: 400 },
        );
      }
      bundles.push(...state.bundles);
      state.committed = true;
      google.committed.push(state);
      return Response.json({ id: edit });
    }
    if (kind === "bundles" && method === "GET") {
      return Response.json({ bundles: bundles.map((versionCode) => ({ versionCode })) });
    }
    if (kind === "bundles" && method === "POST") {
      const text = new TextDecoder().decode(await new Response(init.body).arrayBuffer());
      const versionCode = Number(text.split(":")[2]);
      state.bundles.push(versionCode);
      return Response.json({ versionCode, sha256: "x" });
    }
    if (kind === "tracks" && method === "PUT") {
      state.track = JSON.parse(init.body);
      return Response.json(state.track);
    }
    return Response.json({ error: { message: `Unexpected ${method} ${path}` } }, { status: 500 });
  };
  google.committed = [];
  return { requests, bundles, restore: () => (globalThis.fetch = real) };
}

function setup({ play = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  const SITES = bucket();
  const SOURCES = artifacts();
  const sign = signer();
  const env = {
    DB: d1(sqlite),
    SITES,
    SOURCES,
    SIGNER: sign.binding,
    ...(play ? { NAP_PLAY_SERVICE_ACCOUNT: serviceAccount() } : {}),
  };
  const api = async (method, path, { body, json } = {}) => {
    const url = new URL(`${ORIGIN}/_nap/api/apps${path}`);
    const sent = json ? JSON.stringify(json) : body;
    const request = new Request(url, {
      method,
      ...(sent === undefined ? {} : { body: sent }),
      headers: json
        ? { "content-type": "application/json" }
        : sent
          ? { "content-type": "application/zip", "content-length": String(sent.byteLength) }
          : {},
    });
    return respond(env, handleAppsApi(request, url, AGENT, path.split("?")[0]));
  };
  return { sqlite, SITES, SOURCES, sign, api };
}

const bytes = (text) => new TextEncoder().encode(text);

async function withApps(apps, fn) {
  const previous = napConfig.apps;
  napConfig.apps = apps;
  try {
    await fn();
  } finally {
    napConfig.apps = previous;
  }
}

const ANDROID = { app: "notes", android: { packageName: PACKAGE, testersUrl: null } };

async function created(api, SOURCES) {
  assert.equal((await api("POST", "", { json: { slug: "notes", title: "Notes" } })).status, 201);
  SOURCES.commit("app-notes", sha(1));
}

test("Android without a Play service account: Nap signs, and keeps the bundle for a manual upload", async () => {
  await withApps(ANDROID, async () => {
    const { api, SOURCES, SITES, sign, sqlite } = setup();
    await created(api, SOURCES);

    // A bundle the signer refuses fails, and never goes live.
    let response = await api("POST", `/notes/builds?target=android&sourceCommit=${sha(1)}`, {
      body: bytes("debuggable"),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "The bundle is debuggable.");
    assert.equal((await api("GET", "/notes/targets/android")).status, 404);

    response = await api(
      "POST",
      `/notes/builds?target=android&sourceCommit=${sha(1)}&notes=First`,
      { body: bytes("bundle one") },
    );
    assert.equal(response.status, 201);
    const published = await response.json();
    assert.equal(published.target, "android");
    assert.equal(published.packageName, PACKAGE);
    assert.equal(published.play.state, "manual");
    assert.match(published.play.error, /no Google Play service account/);
    assert.match(published.message, /did not upload it to Google Play/);
    assert.equal(
      published.signedBundle,
      `/_nap/api/apps/notes/targets/android/builds/${published.buildId}/bundle`,
    );
    const last = sign.calls.at(-1);
    assert.equal(last.path, "/sign-android");
    assert.equal(last.headers["x-package-name"], PACKAGE);
    assert.equal(last.headers["x-build-number"], String(published.buildNumber));
    assert.ok(SITES.objects.has(`apps/notes/builds/${published.buildId}/signed.aab`));

    const download = await api("GET", published.signedBundle.slice("/_nap/api/apps".length));
    assert.equal(download.status, 200);
    assert.equal(await download.text(), `signed:${PACKAGE}:${published.buildNumber}:bundle one`);

    const live = (await (await api("GET", "/notes/targets/android")).json()).build;
    assert.equal(live.id, published.buildId);
    assert.equal(live.version, "1.0");
    assert.deepEqual(live.play, {
      state: "manual",
      error: published.play.error,
      bundle: published.signedBundle,
    });
    const target = sqlite
      .prepare("SELECT bundle_id AS id FROM app_targets WHERE target = 'android'")
      .get();
    assert.equal(target.id, `android:${PACKAGE}`);
    const app = (await (await api("GET", "/notes")).json()).app;
    assert.equal(app.targets.find((t) => t.target === "android").bundleId, PACKAGE);
  });
});

test("Android may use the iOS bundle id as its package name", async () => {
  await withApps(ANDROID, async () => {
    const { api, SOURCES, sqlite } = setup();
    await created(api, SOURCES);
    sqlite
      .prepare("INSERT INTO app_targets (app_slug, target, bundle_id) VALUES ('notes', 'ios', ?)")
      .run(PACKAGE);
    const response = await api("POST", `/notes/builds?target=android&sourceCommit=${sha(1)}`, {
      body: bytes("bundle"),
    });
    assert.equal(response.status, 201);
  });
});

test("Android with Play: version codes above Play's, and a completed release on internal testing", async () => {
  await withApps(ANDROID, async () => {
    const fake = google({ bundles: [41, 7] });
    try {
      const { api, SOURCES } = setup({ play: true });
      await created(api, SOURCES);
      const response = await api(
        "POST",
        `/notes/builds?target=android&sourceCommit=${sha(1)}&notes=${encodeURIComponent("New things")}`,
        { body: bytes("bundle") },
      );
      assert.equal(response.status, 201);
      const published = await response.json();
      assert.equal(published.buildNumber, 42);
      assert.deepEqual(published.play, { state: "released", error: null });
      assert.equal(published.signedBundle, undefined);
      assert.match(published.message, /on internal testing in Google Play/);
      const committed = google.committed.at(-1);
      assert.deepEqual(committed.bundles, [42]);
      assert.deepEqual(committed.track, {
        track: "internal",
        releases: [
          {
            versionCodes: ["42"],
            status: "completed",
            releaseNotes: [{ language: "en-US", text: "New things" }],
          },
        ],
      });
    } finally {
      fake.restore();
    }
  });
});

test("Android with Play: a draft app gets a draft release, and an unknown app a manual upload", async () => {
  await withApps(ANDROID, async () => {
    let fake = google({ draftApp: true });
    try {
      const { api, SOURCES } = setup({ play: true });
      await created(api, SOURCES);
      const response = await api("POST", `/notes/builds?target=android&sourceCommit=${sha(1)}`, {
        body: bytes("bundle"),
      });
      assert.equal(response.status, 201);
      const published = await response.json();
      assert.equal(published.buildNumber, 1);
      assert.equal(published.play.state, "draft");
      assert.match(published.message, /draft release/);
      assert.equal(google.committed.at(-1).track.releases[0].status, "draft");
    } finally {
      fake.restore();
    }

    fake = google({ unknown: true });
    try {
      const { api, SOURCES } = setup({ play: true });
      await created(api, SOURCES);
      const response = await api("POST", `/notes/builds?target=android&sourceCommit=${sha(1)}`, {
        body: bytes("bundle"),
      });
      assert.equal(response.status, 201);
      const published = await response.json();
      assert.equal(published.play.state, "manual");
      assert.match(published.play.error, /does not know the app/);
      assert.ok(published.signedBundle);
    } finally {
      fake.restore();
    }
  });
});

test("Nap keeps the files of the newest builds only, and the rows of all", async () => {
  await withApps(ANDROID, async () => {
    const { api, SOURCES, SITES, sqlite } = setup();
    await created(api, SOURCES);
    const ids = [];
    for (let n = 1; n <= 5; n++) {
      const response = await api("POST", `/notes/builds?target=android&sourceCommit=${sha(1)}`, {
        body: bytes(`bundle ${n}`),
      });
      assert.equal(response.status, 201);
      ids.push((await response.json()).buildId);
    }
    const kept = (id) => [...SITES.objects.keys()].some((key) => key.includes(`/builds/${id}/`));
    assert.deepEqual(ids.map(kept), [false, false, true, true, true]);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM app_builds").get().n, 5);
    const deleted = sqlite
      .prepare("SELECT id FROM app_builds WHERE files_deleted_at IS NOT NULL ORDER BY build_number")
      .all()
      .map((row) => row.id);
    assert.deepEqual(deleted, ids.slice(0, 2));

    const gone = await api("GET", `/notes/targets/android/builds/${ids[0]}/bundle`);
    assert.equal(gone.status, 410);
    assert.equal((await gone.json()).code, "build_files_deleted");
    assert.equal((await api("GET", `/notes/targets/android/builds/${ids[4]}/bundle`)).status, 200);
  });
});
