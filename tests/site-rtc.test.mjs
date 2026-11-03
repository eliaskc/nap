import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export const env = {}; export class DurableObject {}",
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
const { handleRtcRequest, STUN_ONLY, usableServers } = await import("../src/lib/site-rtc.ts");
const { respond, runNap } = await import("../src/server/runtime.ts");
const { siteManifest } = await import("../src/lib/site-manifest.ts");

const OWNER = "owner@example.com";
const OTHER = "other@example.com";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO profiles (email) VALUES ('${OWNER}'), ('${OTHER}');
    INSERT INTO sites (slug, title, created_by_email, updated_by_email, current_version, sort_order,
      visibility)
      VALUES ('open', 'Open', '${OWNER}', '${OWNER}', 'v1', 1, 'everyone'),
             ('private', 'Private', '${OWNER}', '${OWNER}', 'v1', 2, 'selected');`);
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
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
      };
    },
  };
}

const TURN = { NAP_TURN_KEY_ID: "key", NAP_TURN_KEY_API_TOKEN: "secret" };

async function rtc(env, { slug = "open", email = OTHER, method = "GET" } = {}) {
  const request = new Request(`https://${slug}.nap.test/_nap/rtc`, { method });
  const response = await respond(env, handleRtcRequest(slug, request, { email, name: email }));
  return { status: response.status, body: await response.json(), response };
}

/** Replaces fetch for one test, and records what was sent. */
function mockFetch(t, answer) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return answer(url, init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test("rtc: GET only, and only for people who can view the site", async () => {
  const env = { DB: database() };
  assert.equal((await rtc(env, { method: "POST" })).status, 405);
  assert.equal((await rtc(env, { slug: "private" })).status, 404);
  assert.equal((await rtc(env, { slug: "missing" })).status, 404);
  const owner = await rtc(env, { slug: "private", email: OWNER });
  assert.equal(owner.status, 200);
  assert.equal(owner.response.headers.get("cache-control"), "no-store");
});

test("rtc: without a TURN key, STUN only", async (t) => {
  const calls = mockFetch(t, () => new Response("{}"));
  const { status, body } = await rtc({ DB: database() });
  assert.equal(status, 200);
  assert.deepEqual(body, { iceServers: STUN_ONLY, turn: false, expiresAt: null });
  assert.equal(calls.length, 0);
});

test("rtc: TURN credentials from Cloudflare, without port 53", async (t) => {
  const calls = mockFetch(t, () =>
    Response.json({
      iceServers: [
        {
          urls: [
            "stun:stun.cloudflare.com:3478",
            "turn:turn.cloudflare.com:53?transport=udp",
            "turn:turn.cloudflare.com:3478?transport=udp",
          ],
          username: "u",
          credential: "c",
        },
      ],
    }),
  );
  const { status, body } = await rtc({ DB: database(), ...TURN });
  assert.equal(status, 200);
  assert.equal(body.turn, true);
  assert.ok(Date.parse(body.expiresAt) > Date.now());
  assert.deepEqual(body.iceServers, [
    {
      urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp"],
      username: "u",
      credential: "c",
    },
  ]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/turn\/keys\/key\/credentials\/generate-ice-servers$/);
  assert.equal(calls[0].init.headers.authorization, "Bearer secret");
});

test("rtc: a failing or odd TURN API falls back to STUN only", async (t) => {
  const answers = [
    () => new Response("nope", { status: 500 }),
    () => new Response("not json"),
    () => Response.json({ iceServers: "nope" }),
    () => Response.json({ iceServers: [{ urls: ["turn:turn.cloudflare.com:53"] }] }),
    () => Promise.reject(new TypeError("network down")),
  ];
  let next = 0;
  mockFetch(t, () => answers[next++]());
  for (let i = 0; i < answers.length; i++) {
    const { status, body } = await rtc({ DB: database(), ...TURN });
    assert.equal(status, 200, `answer ${i}`);
    assert.deepEqual(body, { iceServers: STUN_ONLY, turn: false, expiresAt: null }, `answer ${i}`);
  }
});

test("usableServers drops port 53 and empty servers", () => {
  assert.equal(usableServers([{ urls: "turn:x:53" }]), null);
  assert.deepEqual(
    usableServers([{ urls: "turn:x:3478" }, { urls: ["turn:x:53?transport=tcp"] }]),
    [{ urls: ["turn:x:3478"] }],
  );
});

test("nap.json is read once per version, and a broken file means the defaults", async () => {
  const files = {
    "sites/a/versions/v1/nap.json": JSON.stringify({
      spa: true,
      fetch: ["api.example.com", "bad host"],
    }),
    "sites/b/versions/v1/nap.json": "{ not json",
  };
  let reads = 0;
  const SITES = {
    async get(key) {
      reads++;
      const text = files[key];
      return text === undefined ? null : { json: async () => JSON.parse(text) };
    },
  };
  const env = { DB: database(), SITES };
  const read = (slug) => runNap(env, siteManifest(slug, "v1"));
  const data = { allow: {} };
  assert.deepEqual(await read("a"), { spa: true, fetch: ["api.example.com"], data });
  assert.deepEqual(await read("a"), { spa: true, fetch: ["api.example.com"], data });
  assert.equal(reads, 1);
  assert.deepEqual(await read("b"), { spa: false, fetch: [], data });
  assert.deepEqual(await read("c"), { spa: false, fetch: [], data });
});
