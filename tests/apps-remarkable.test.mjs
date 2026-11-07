import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

// apps.ts reaches nap-server.ts, which imports the Workers runtime and uses the ~/ alias.
// The templates are bundled by Vite (import.meta.glob), which Node does not have.
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
        url: `data:text/javascript,export const appTemplateFiles = () => [{ path: "nap.json", content: "{}", encoding: "utf8", executable: false }];`,
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

// Workers globals that Node lacks: FixedLengthStream and crypto.DigestStream.
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
crypto.DigestStream ??= class extends WritableStream {
  constructor() {
    const hash = createHash("sha256");
    let resolve;
    const digest = new Promise((r) => (resolve = r));
    super({
      write(chunk) {
        hash.update(chunk);
      },
      close() {
        resolve(new Uint8Array(hash.digest()).buffer);
      },
    });
    this.digest = digest;
  }
};

const { napConfig } = await import("../nap.config.ts");
const { handleAppsApi } = await import("../src/lib/apps.ts");
const { respond } = await import("../src/server/runtime.ts");

const AGENT = { email: "owner@example.com", name: "", tokenId: "t1", client: "Test agent" };
const ORIGIN = "https://nap.example.com";
const sha = (n) => n.toString(16).padStart(40, "0");

function d1(sqlite) {
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind(...values) {
      return statement(sql, values);
    },
    async first() {
      return sqlite.prepare(sql).get(...args) ?? null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...args) };
    },
    async run() {
      const result = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  return { prepare: (sql) => statement(sql) };
}

/** An in-memory Artifacts namespace: commits with parents, and a main branch. */
function artifacts() {
  const repos = new Map();
  const handle = (name) => {
    const repo = repos.get(name);
    return {
      async info() {
        return { name, remote: `https://acct.artifacts.cloudflare.net/git/s/${name}.git` };
      },
      async createToken(scope, ttl) {
        return { plaintext: `art_${scope}`, expiresAt: new Date(ttl * 1000).toISOString() };
      },
      async log({ ref = "main", limit = 50 } = {}) {
        let hash = ref === "main" ? repo.main : ref;
        const line = [];
        while (hash && repo.commits.has(hash) && line.length < limit) {
          line.push({ hash, parents: repo.commits.get(hash) });
          hash = repo.commits.get(hash)[0];
        }
        return line;
      },
      async readCommit(hash) {
        return repo.commits.has(hash) ? { hash, parents: repo.commits.get(hash) } : null;
      },
      [Symbol.dispose]() {},
    };
  };
  return {
    repos,
    async create(name) {
      if (repos.has(name)) throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
      repos.set(name, { commits: new Map(), main: null });
      return { name, token: "art_initial" };
    },
    async get(name) {
      if (!repos.has(name)) throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
      return handle(name);
    },
    async delete(name) {
      return repos.delete(name);
    },
    commit(name, hash, parents = []) {
      const repo = repos.get(name);
      repo.commits.set(hash, parents);
      repo.main = hash;
    },
  };
}

/** An in-memory R2 bucket that reads streams to the end, like R2. */
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
      return {
        body: new Response(object.bytes).body,
        size: object.bytes.byteLength,
        arrayBuffer: async () => object.bytes.slice().buffer,
      };
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength } : null;
    },
  };
}

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  const SITES = bucket();
  const SOURCES = artifacts();
  const env = { DB: d1(sqlite), SITES, SOURCES };
  const api = async (method, path, { body, json, headers = {} } = {}) => {
    const url = new URL(`${ORIGIN}/_nap/api/apps${path}`);
    const sent = json ? JSON.stringify(json) : body;
    const request = new Request(url, {
      method,
      ...(sent === undefined ? {} : { body: sent }),
      headers: json ? { "content-type": "application/json" } : headers,
    });
    return respond(env, handleAppsApi(request, url, AGENT, path.split("?")[0]));
  };
  return { sqlite, SITES, SOURCES, env, api };
}

const zipBytes = (text) =>
  new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(text)]);
const upload = (bytes) => ({
  body: bytes,
  headers: { "content-type": "application/zip", "content-length": String(bytes.byteLength) },
});
const hexOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Runs fn with napConfig.apps set to apps, and puts it back after. */
async function withApps(apps, fn) {
  const previous = napConfig.apps;
  napConfig.apps = apps;
  try {
    await fn();
  } finally {
    napConfig.apps = previous;
  }
}

test("reMarkable is a platform only when the config turns it on", async () => {
  await withApps({ app: "notes" }, async () => {
    const { api, SOURCES } = setup();
    assert.equal((await api("POST", "", { json: { slug: "notes" } })).status, 201);
    SOURCES.commit("app-notes", sha(1));
    const response = await api(
      "POST",
      `/notes/builds?target=remarkable&sourceCommit=${sha(1)}`,
      upload(zipBytes("x")),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "not_distributed");
    const download = await api(
      "GET",
      "/notes/targets/remarkable/builds/00000000-0000-0000-0000-000000000000/download",
    );
    assert.equal(download.status, 404);
  });
});

test("reMarkable: publish, live, download, and build numbers per target", async () => {
  await withApps({ app: "notes", remarkable: {} }, async () => {
    const { api, SOURCES, SITES, sqlite } = setup();
    assert.equal((await api("POST", "", { json: { slug: "notes", title: "Notes" } })).status, 201);
    const live = async () => api("GET", "/notes/targets/remarkable");
    assert.equal((await (await live()).json()).code, "no_live_build");

    // The only platform: target may be left out. The commit must be the head of main.
    const first = zipBytes("first build");
    let response = await api("POST", `/notes/builds?sourceCommit=${sha(1)}`, upload(first));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "source_not_head");
    SOURCES.commit("app-notes", sha(1));

    // Not a zip: the build fails and never goes live.
    response = await api(
      "POST",
      `/notes/builds?target=remarkable&sourceCommit=${sha(1)}`,
      upload(new TextEncoder().encode("hello, not a zip")),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "build_failed");
    assert.equal((await live()).status, 404);

    response = await api(
      "POST",
      `/notes/builds?target=remarkable&sourceCommit=${sha(1)}&notes=First`,
      upload(first),
    );
    assert.equal(response.status, 201);
    const published = await response.json();
    assert.equal(published.target, "remarkable");
    assert.equal(published.sha256, hexOf(first));
    assert.match(published.message, /reMarkable launcher is live/);
    assert.ok(SITES.objects.has(`apps/notes/builds/${published.buildId}/unsigned.zip`));

    const build = (await (await live()).json()).build;
    assert.equal(build.id, published.buildId);
    assert.equal(build.buildNumber, published.buildNumber);
    assert.equal(build.notes, "First");
    assert.equal(build.sha256, hexOf(first));
    assert.equal(build.bytes, first.byteLength);
    assert.equal(
      build.download,
      `/_nap/api/apps/notes/targets/remarkable/builds/${published.buildId}/download`,
    );
    const download = await api("GET", build.download.slice("/_nap/api/apps".length));
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/zip");
    assert.equal(download.headers.get("x-nap-sha256"), hexOf(first));
    assert.equal(download.headers.get("x-nap-build-number"), String(build.buildNumber));
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), first);
    const head = await api("HEAD", build.download.slice("/_nap/api/apps".length));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(first.byteLength));

    // The next build must contain the live build's commit.
    SOURCES.commit("app-notes", sha(9), []);
    const second = zipBytes("second build");
    response = await api(
      "POST",
      `/notes/builds?target=remarkable&sourceCommit=${sha(9)}`,
      upload(second),
    );
    assert.equal((await response.json()).code, "source_not_descendant");
    SOURCES.commit("app-notes", sha(2), [sha(1)]);
    response = await api(
      "POST",
      `/notes/builds?target=remarkable&sourceCommit=${sha(2)}`,
      upload(second),
    );
    assert.equal(response.status, 201);
    assert.equal((await response.json()).buildNumber, published.buildNumber + 1);
    assert.equal((await (await live()).json()).build.sha256, hexOf(second));
    const old = await api("GET", build.download.slice("/_nap/api/apps".length));
    assert.deepEqual(new Uint8Array(await old.arrayBuffer()), first, "old builds stay");

    const target = sqlite
      .prepare("SELECT bundle_id AS id FROM app_targets WHERE target = 'remarkable'")
      .get();
    assert.equal(target.id, "notes.remarkable");
    const app = (await (await api("GET", "/notes")).json()).app;
    assert.deepEqual(
      app.targets.map((t) => [t.target, t.platform, t.live?.buildNumber]),
      [["remarkable", "reMarkable", published.buildNumber + 1]],
    );
  });
});

test("a build keeps the apps inside it, and the sheet shows them with the nudge flag", async () => {
  await withApps({ app: "notes", remarkable: {} }, async () => {
    const { api, SOURCES, env, sqlite } = setup();
    assert.equal((await api("POST", "", { json: { slug: "notes", title: "Notes" } })).status, 201);
    SOURCES.commit("app-notes", sha(1));
    const apps = JSON.stringify([
      { slug: "hello", title: "Hello", summary: "Who you are." },
      { slug: "draw", title: "", summary: 7 },
      { title: "No slug" },
    ]);
    const response = await api(
      "POST",
      `/notes/builds?target=remarkable&sourceCommit=${sha(1)}&apps=${encodeURIComponent(apps)}`,
      upload(zipBytes("with apps")),
    );
    assert.equal(response.status, 201);

    sqlite.prepare("INSERT INTO profiles (email, display_name) VALUES (?, ?)").run("p@x.com", "P");
    const { appSheet, dismissAppNudge } = await import("../src/lib/apps.ts");
    const { runNap } = await import("../src/server/runtime.ts");
    let sheet = await runNap(env, appSheet("p@x.com", ORIGIN));
    assert.equal(sheet.title, "Notes");
    assert.deepEqual(sheet.platforms[0].live.apps, [
      { slug: "hello", title: "Hello", summary: "Who you are." },
      { slug: "draw", title: "draw", summary: "" },
    ]);
    assert.equal(sheet.nudgeDismissed, false);
    await runNap(env, dismissAppNudge("p@x.com"));
    sheet = await runNap(env, appSheet("p@x.com", ORIGIN));
    assert.equal(sheet.nudgeDismissed, true);
  });
});
