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
const { handleSiteFetch, readForwardedHeaders } = await import("../src/lib/site-fetch.ts");
const { respond } = await import("../src/server/runtime.ts");

const OWNER = "owner@example.com";

function environment() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO profiles (email) VALUES ('${OWNER}');
    INSERT INTO sites (slug, title, created_by_email, updated_by_email, current_version, sort_order,
      visibility, kind)
      VALUES ('games', 'Games', '${OWNER}', '${OWNER}', 'v1', 1, 'everyone', 'site');`);
  const DB = {
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
  const manifest = { fetch: ["api.example.com"] };
  const SITES = {
    async get(key) {
      return key === "sites/games/versions/v1/nap.json"
        ? { json: async () => manifest, text: async () => JSON.stringify(manifest) }
        : null;
    },
  };
  return { DB, SITES };
}

/** Records upstream requests and answers each with `reply`. */
function upstream(reply = () => new Response("ok", { headers: { "content-type": "text/plain" } })) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return reply(String(url), init);
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

function call(env, url, init = {}) {
  const request = new Request(
    `https://games.nap.test/_nap/fetch?url=${encodeURIComponent(url)}`,
    init,
  );
  return respond(env, handleSiteFetch("games", request, OWNER));
}

test("page headers: only explicit ones, and never Nap's or the viewer's", () => {
  assert.deepEqual(readForwardedHeaders(null), {});
  assert.equal(typeof readForwardedHeaders("[1]"), "string");
  assert.equal(typeof readForwardedHeaders("{"), "string");
  assert.equal(typeof readForwardedHeaders('{"a":1}'), "string");
  assert.deepEqual(
    readForwardedHeaders(
      JSON.stringify({
        Authorization: "Bearer x",
        Referer: "https://example.com/",
        Cookie: "session=1",
        Host: "evil",
        "CF-Connecting-IP": "1.2.3.4",
        "X-Forwarded-For": "1.2.3.4",
        "x-nap-fetch-headers": "{}",
      }),
    ),
    { authorization: "Bearer x", referer: "https://example.com/" },
  );
});

test("a plain GET is cached and sends none of the viewer's headers", async () => {
  const env = environment();
  const mock = upstream();
  try {
    const response = await call(env, "https://api.example.com/today", {
      headers: { cookie: "CF_Authorization=secret", accept: "application/json" },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.match(response.headers.get("cache-control"), /max-age=300/);
    const { init } = mock.calls[0];
    assert.equal(init.method, "GET");
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.headers.accept, "application/json");
    assert.equal(init.cf.cacheEverything, true);
  } finally {
    mock.restore();
  }
});

test("POST passes the body and the page's headers, uncached", async () => {
  const env = environment();
  const mock = upstream(() => Response.json({ correct: true }));
  try {
    const response = await call(env, "https://api.example.com/guess", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "CF_Authorization=secret",
        "x-nap-fetch-headers": JSON.stringify({
          "content-type": "application/json",
          referer: "https://example.com/",
          cookie: "nope",
        }),
      },
      body: JSON.stringify({ direction: "left" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { correct: true });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { init } = mock.calls[0];
    assert.equal(init.method, "POST");
    assert.equal(new TextDecoder().decode(init.body), '{"direction":"left"}');
    assert.equal(init.headers.referer, "https://example.com/");
    assert.equal(init.headers["content-type"], "application/json");
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.cf, undefined);
  } finally {
    mock.restore();
  }
});

test("a GET with the page's own headers is not cached", async () => {
  const env = environment();
  const mock = upstream();
  try {
    const response = await call(env, "https://api.example.com/signed", {
      headers: { "x-nap-fetch-headers": JSON.stringify({ authorization: "Bearer t" }) },
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(mock.calls[0].init.headers.authorization, "Bearer t");
    assert.equal(mock.calls[0].init.cf, undefined);
  } finally {
    mock.restore();
  }
});

test("refuses other hosts, other methods, and big bodies", async () => {
  const env = environment();
  const mock = upstream();
  try {
    assert.equal((await call(env, "https://other.example.com/")).status, 403);
    assert.equal((await call(env, "https://api.example.com/", { method: "OPTIONS" })).status, 405);
    const big = await call(env, "https://api.example.com/", {
      method: "POST",
      body: "x".repeat(300 * 1024),
    });
    assert.equal(big.status, 413);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("a 303 after a POST is followed as a GET without the body", async () => {
  const env = environment();
  const mock = upstream((url) =>
    url.endsWith("/post")
      ? new Response(null, { status: 303, headers: { location: "/result" } })
      : new Response("done"),
  );
  try {
    const response = await call(env, "https://api.example.com/post", {
      method: "POST",
      body: "a=1",
    });
    assert.equal(await response.text(), "done");
    assert.equal(mock.calls[1].init.method, "GET");
    assert.equal(mock.calls[1].init.body, null);
  } finally {
    mock.restore();
  }
});

test("errors are never cached", async () => {
  const env = environment();
  const mock = upstream(() => new Response("gone", { status: 404 }));
  try {
    const response = await call(env, "https://api.example.com/missing");
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    mock.restore();
  }
});

test("artifacts fetch below their frame token, which is cross-site by nature", async () => {
  const env = environment();
  await env.DB.prepare(`UPDATE sites SET kind = 'artifact' WHERE slug = 'games'`).run();
  const mock = upstream();
  try {
    const request = () =>
      new Request(
        `https://nap.test/_nap/frame/t/_nap/fetch?url=${encodeURIComponent("https://api.example.com/x")}`,
        { headers: { "sec-fetch-site": "cross-site" } },
      );
    const framed = await respond(env, handleSiteFetch("games", request(), OWNER, { frame: true }));
    assert.equal(framed.status, 200);
    assert.equal(await framed.text(), "ok");
    // Not on a site's host: an artifact has none, and cross-site requests are refused there.
    const unframed = await respond(env, handleSiteFetch("games", request(), OWNER));
    assert.equal(unframed.status, 403);
  } finally {
    mock.restore();
  }
});
