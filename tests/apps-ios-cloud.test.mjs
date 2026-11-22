import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

// Like apps-android.test.mjs: apps.ts reaches the Workers runtime and Vite-only imports.
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
  constructor(algorithm) {
    const hash = createHash(algorithm.replace("-", "").toLowerCase());
    let done;
    super({
      write: (chunk) => void hash.update(chunk),
      close: () => done(hash.digest().buffer),
    });
    this.digest = new Promise((resolve) => (done = resolve));
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
const { handleAppsApi, handleSigningApi } = await import("../src/lib/apps.ts");
const { respond } = await import("../src/server/runtime.ts");

const AGENT = { email: "owner@example.com", name: "", tokenId: "t1", client: "Test agent" };
const ORIGIN = "https://nap.example.com";
const BUNDLE = "com.example.nap";
const SECRET = "job-secret";
const sha = (n) => n.toString(16).padStart(40, "0");
const bytes = (text) => new TextEncoder().encode(text);

const IOS = {
  app: "notes",
  ios: {
    teamId: "TEAM123456",
    appStoreId: "6000000001",
    bundleId: BUNDLE,
    signing: { cloud: { repository: "example/nap-config" } },
  },
};

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
      const stored = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes: stored, options });
      return { key, size: stored.byteLength };
    },
    async get(key, options) {
      const object = objects.get(key);
      if (!object) return null;
      const range = options?.range;
      const part = range
        ? object.bytes.subarray(range.offset, range.offset + range.length)
        : object.bytes;
      return { body: new Response(part).body, size: part.byteLength };
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

/** The signer container, which with cloud signing only reads what a build asks for. */
function signer(capabilities) {
  const calls = [];
  const stub = {
    async fetch(request) {
      calls.push(new URL(request.url).pathname);
      await request.arrayBuffer();
      return Response.json({ capabilities, extensions: [] });
    },
  };
  return { calls, binding: { idFromName: () => "signer", get: () => stub } };
}

/**
 * GitHub and Apple, in memory. `dispatch` is GitHub's answer to starting the workflow;
 * `appleBuilds` the build numbers App Store Connect has; `capabilitiesOn` the App ID's.
 */
function world({ dispatch = 204, appleBuilds = [], capabilitiesOn = [] } = {}) {
  const calls = [];
  const dispatched = [];
  const uploaded = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.host}${url.pathname}`);
    if (url.host === "api.github.com") {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer ghp_test");
      dispatched.push({ path: url.pathname, body: JSON.parse(init.body) });
      return dispatch === 204
        ? new Response(null, { status: 204 })
        : Response.json({ message: "Not Found" }, { status: dispatch });
    }
    if (url.host === "upload.example.com") {
      uploaded.push(new TextDecoder().decode(await new Response(init.body).arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    assert.equal(url.host, "api.appstoreconnect.apple.com");
    const path = url.pathname.replace("/v1/", "");
    if (method === "GET" && path.endsWith("/buildUploads")) return Response.json({ data: [] });
    if (method === "GET" && path === "builds") {
      return Response.json({
        data: appleBuilds.map((version) => ({ attributes: { version: String(version) } })),
      });
    }
    if (method === "GET" && path === "bundleIds") {
      return Response.json({ data: [{ id: "B1", attributes: { identifier: BUNDLE } }] });
    }
    if (method === "GET" && path === "bundleIds/B1/bundleIdCapabilities") {
      return Response.json({
        data: capabilitiesOn.map((capabilityType) => ({ attributes: { capabilityType } })),
      });
    }
    if (method === "POST" && path === "bundleIdCapabilities") {
      return Response.json({ data: { id: "C1" } }, { status: 201 });
    }
    if (method === "POST" && path === "buildUploads") {
      return Response.json({ data: { id: "U1" } }, { status: 201 });
    }
    if (method === "POST" && path === "buildUploadFiles") {
      const size = JSON.parse(init.body).data.attributes.fileSize;
      return Response.json(
        {
          data: {
            id: "F1",
            attributes: {
              uploadOperations: [
                { method: "PUT", url: "https://upload.example.com/part", offset: 0, length: size },
              ],
            },
          },
        },
        { status: 201 },
      );
    }
    if (method === "PATCH" && path === "buildUploadFiles/F1") return Response.json({ data: {} });
    return Response.json({ errors: [{ detail: `Unexpected ${method} ${path}` }] }, { status: 500 });
  };
  return { calls, dispatched, uploaded, restore: () => (globalThis.fetch = real) };
}

function setup({ secrets = true, sign = null } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  const SITES = bucket();
  const SOURCES = artifacts();
  const env = {
    DB: d1(sqlite),
    SITES,
    SOURCES,
    ...(sign ? { SIGNER: sign.binding } : {}),
    NAP_ROOT_DOMAIN: "nap.example.com",
    NAP_ASC_KEY_ID: "KEY",
    NAP_ASC_ISSUER_ID: "issuer",
    NAP_ASC_PRIVATE_KEY: generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    ...(secrets ? { NAP_SIGNING_GITHUB_TOKEN: "ghp_test", NAP_SIGNING_SECRET: SECRET } : {}),
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
  /** The signing job's requests. `secret: null` sends none. */
  const job = async (method, path, { body, json, secret = SECRET } = {}) => {
    const url = new URL(`${ORIGIN}/_nap/api/signing${path}`);
    const sent = json ? JSON.stringify(json) : body;
    const request = new Request(url, {
      method,
      ...(sent === undefined ? {} : { body: sent }),
      headers: {
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(json ? { "content-type": "application/json" } : {}),
        ...(body ? { "content-length": String(body.byteLength) } : {}),
      },
    });
    return respond(env, handleSigningApi(request, url, path.split("?")[0]));
  };
  return { sqlite, SITES, SOURCES, api, job };
}

async function withApps(apps, fn) {
  const previous = napConfig.apps;
  napConfig.apps = apps;
  try {
    await fn();
  } finally {
    napConfig.apps = previous;
  }
}

async function created(api, SOURCES) {
  assert.equal((await api("POST", "", { json: { slug: "notes", title: "Notes" } })).status, 201);
  SOURCES.commit("app-notes", sha(1));
}

const publish = (api, commit, text) =>
  api("POST", `/notes/builds?target=ios&sourceCommit=${sha(commit)}&notes=Hi`, {
    body: bytes(text),
  });

test("cloud signing: the publish starts the job, and the build goes live when the job hands the app back", async () => {
  await withApps(IOS, async () => {
    const outside = world({ appleBuilds: [41] });
    try {
      const { api, job, SOURCES, SITES } = setup();
      await created(api, SOURCES);

      const response = await publish(api, 1, "unsigned app");
      assert.equal(response.status, 202);
      const published = await response.json();
      assert.equal(published.status, "signing");
      assert.equal(published.buildNumber, 42);
      assert.equal(published.bundleId, BUNDLE);
      assert.match(published.message, /Build 42 of the iOS app is being signed/);
      assert.match(published.readyMessage, /Build 42 of the iOS app is uploaded to TestFlight/);

      // Nap started the workflow in the config repository, with the build and where Nap is.
      assert.deepEqual(outside.dispatched, [
        {
          path: "/repos/example/nap-config/actions/workflows/sign-ios.yml/dispatches",
          body: {
            ref: "main",
            inputs: { build: published.buildId, nap: "https://nap.example.com" },
          },
        },
      ]);
      // Not live yet, and the agent can watch it.
      assert.equal((await api("GET", "/notes/targets/ios")).status, 404);
      let build = (await (await api("GET", `/notes/builds/${published.buildId}`)).json()).build;
      assert.equal(build.status, "signing");

      // Only the job's secret opens its routes.
      const path = `/builds/${published.buildId}`;
      assert.equal((await job("GET", path, { secret: null })).status, 401);
      assert.equal((await job("GET", path, { secret: "wrong" })).status, 401);
      const described = await (await job("GET", path)).json();
      assert.deepEqual(described, {
        build: published.buildId,
        buildNumber: 42,
        bundleId: BUNDLE,
        teamId: "TEAM123456",
        entitlementKeys: [],
        warnings: {},
        unsigned: `${ORIGIN}/_nap/api/signing${path}/unsigned`,
        signed: `${ORIGIN}/_nap/api/signing${path}/signed`,
        failed: `${ORIGIN}/_nap/api/signing${path}/failed`,
      });
      const unsigned = await job("GET", `${path}/unsigned`);
      assert.equal(await unsigned.text(), "unsigned app");

      // The job hands the signed app back: Nap uploads it to TestFlight and makes the build live.
      const done = await job("PUT", `${path}/signed?name=Notes&version=1.2&xcode=2620`, {
        body: bytes("signed ipa"),
      });
      assert.equal(done.status, 200);
      assert.deepEqual(outside.uploaded, ["signed ipa"]);
      assert.ok(
        SITES.objects.has(`apps/notes/builds/${published.buildId}/signed-appstore-cloud.ipa`),
      );
      const live = (await (await api("GET", "/notes/targets/ios")).json()).build;
      assert.equal(live.id, published.buildId);
      assert.equal(live.status, "ready");
      assert.equal(live.name, "Notes");
      assert.equal(live.version, "1.2");
      assert.equal(live.xcode, "2620");
      assert.deepEqual(live.testFlight, { state: "processing", error: null });

      // A build that is done takes nothing more from the job.
      assert.equal((await job("GET", path)).status, 409);
      assert.equal((await job("PUT", `${path}/signed`, { body: bytes("again") })).status, 409);
      build = (await (await api("GET", `/notes/builds/${published.buildId}`)).json()).build;
      assert.equal(build.status, "ready");
    } finally {
      outside.restore();
    }
  });
});

test("cloud signing: a job that fails fails the build, which never goes live", async () => {
  await withApps(IOS, async () => {
    const outside = world();
    try {
      const { api, job, SOURCES } = setup();
      await created(api, SOURCES);
      const published = await (await publish(api, 1, "unsigned app")).json();
      const failed = await job("POST", `/builds/${published.buildId}/failed`, {
        json: { error: "xcodebuild: No profiles for 'com.example.nap' were found" },
      });
      assert.equal(failed.status, 200);
      const build = (await (await api("GET", `/notes/builds/${published.buildId}`)).json()).build;
      assert.equal(build.status, "failed");
      assert.match(build.error, /No profiles/);
      assert.equal((await api("GET", "/notes/targets/ios")).status, 404);
      assert.equal(outside.uploaded.length, 0);
    } finally {
      outside.restore();
    }
  });
});

test("cloud signing: a workflow that cannot be started fails the publish", async () => {
  await withApps(IOS, async () => {
    const outside = world({ dispatch: 404 });
    try {
      const { api, SOURCES, sqlite } = setup();
      await created(api, SOURCES);
      const response = await publish(api, 1, "unsigned app");
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.match(
        body.error,
        /Could not start the signing job \(sign-ios.yml in example\/nap-config\): Not Found/,
      );
      assert.equal(sqlite.prepare("SELECT status FROM app_builds").get().status, "failed");
    } finally {
      outside.restore();
    }
  });
});

test("cloud signing: without its secrets, publishing says what is missing", async () => {
  await withApps(IOS, async () => {
    const outside = world();
    try {
      const { api, job, SOURCES } = setup({ secrets: false });
      await created(api, SOURCES);
      const response = await publish(api, 1, "unsigned app");
      assert.equal(response.status, 503);
      assert.match(
        (await response.json()).error,
        /NAP_SIGNING_GITHUB_TOKEN and NAP_SIGNING_SECRET/,
      );
      assert.equal((await job("GET", `/builds/${crypto.randomUUID()}`)).status, 401);
    } finally {
      outside.restore();
    }
  });
});

test("cloud signing: a job that never reports back fails the build after half an hour", async () => {
  await withApps(IOS, async () => {
    const outside = world();
    try {
      const { api, job, SOURCES, sqlite } = setup();
      await created(api, SOURCES);
      const published = await (await publish(api, 1, "unsigned app")).json();
      sqlite
        .prepare("UPDATE app_builds SET created_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 31 * 60 * 1000).toISOString(), published.buildId);
      const build = (await (await api("GET", `/notes/builds/${published.buildId}`)).json()).build;
      assert.equal(build.status, "failed");
      assert.match(build.error, /The signing job did not finish/);
      // A job that turns up late is told so.
      const late = await job("PUT", `/builds/${published.buildId}/signed`, { body: bytes("ipa") });
      assert.equal(late.status, 409);
    } finally {
      outside.restore();
    }
  });
});

test("cloud signing: Nap turns on what the build asks for and tells the job which entitlements", async () => {
  await withApps(IOS, async () => {
    const outside = world();
    try {
      const sign = signer({ walks: ["healthkit", "icloud"] });
      const { api, job, SOURCES } = setup({ sign });
      await created(api, SOURCES);
      const published = await (await publish(api, 1, "unsigned app")).json();
      assert.deepEqual(sign.calls, ["/inspect"]);
      assert.deepEqual(published.capabilities, ["healthkit"]);
      assert.match(published.message, /walks: iCloud needs an iCloud container registered first\./);
      // Turned on for the App ID. Xcode remakes the profile, so Nap makes none.
      assert.ok(
        outside.calls.includes("POST api.appstoreconnect.apple.com/v1/bundleIdCapabilities"),
      );
      assert.ok(!outside.calls.some((call) => call.includes("/v1/profiles")));
      const described = await (await job("GET", `/builds/${published.buildId}`)).json();
      assert.deepEqual(described.entitlementKeys, [
        "com.apple.developer.healthkit",
        "com.apple.developer.healthkit.access",
      ]);
      assert.deepEqual(described.warnings, {
        walks: ["iCloud needs an iCloud container registered first."],
      });
    } finally {
      outside.restore();
    }
  });
});

test("cloud signing: a build that a newer one overtook does not go live", async () => {
  await withApps(IOS, async () => {
    const outside = world();
    try {
      const { api, job, SOURCES } = setup();
      await created(api, SOURCES);
      const first = await (await publish(api, 1, "first")).json();
      SOURCES.commit("app-notes", sha(2), [sha(1)]);
      const second = await (await publish(api, 2, "second")).json();
      assert.equal(second.buildNumber, first.buildNumber + 1);

      assert.equal(
        (await job("PUT", `/builds/${second.buildId}/signed`, { body: bytes("ipa 2") })).status,
        200,
      );
      const late = await job("PUT", `/builds/${first.buildId}/signed`, { body: bytes("ipa 1") });
      assert.equal(late.status, 409);
      assert.match((await late.json()).error, /went live while this one was processed/);
      const build = (await (await api("GET", `/notes/builds/${first.buildId}`)).json()).build;
      assert.equal(build.status, "failed");
      const live = (await (await api("GET", "/notes/targets/ios")).json()).build;
      assert.equal(live.id, second.buildId);
    } finally {
      outside.restore();
    }
  });
});
