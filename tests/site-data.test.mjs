import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

// site-data.ts reaches nap-server.ts, which imports the Workers runtime and uses the ~/ alias.
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
const {
  handleSiteDataRequest,
  siteDataTarget,
  viewersAmong: viewersAmongEffect,
} = await import("../src/lib/site-data.ts");
const { respond, runNap } = await import("../src/server/runtime.ts");
const viewersAmong = (env, slug, emails) => runNap(env, viewersAmongEffect(slug, emails));

const OWNER = "owner@example.com";
const OTHER = "other@example.com";

function database({ before } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations").sort()) {
    if (file === before) break;
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO profiles (email) VALUES ('${OWNER}'), ('${OTHER}');
    INSERT INTO sites (slug, title, created_by_email, updated_by_email, current_version, sort_order,
      visibility)
      VALUES ('elo', 'Elo', '${OWNER}', '${OWNER}', 'v1', 1, 'everyone'),
             ('other', 'Other', '${OWNER}', '${OWNER}', 'v1', 2, 'everyone');`);
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
  // Elo's live nap.json lets the "other" site's pages use its "scores" collection.
  const manifests = {
    "sites/elo/versions/v1/nap.json": { data: { allow: { other: ["scores"] } } },
  };
  const SITES = {
    async get(key) {
      const manifest = manifests[key];
      return manifest ? { json: async () => manifest } : null;
    },
  };
  return { sqlite, env: { DB, SITES } };
}

function client(env, { slug = "elo", email = OWNER } = {}) {
  return async (method, path, { body, headers = {} } = {}) => {
    const request = new Request(`https://${slug}.nap.test/_nap/data/${path}`, {
      method,
      headers: {
        "cf-access-authenticated-user-email": email,
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // The Worker passes the path without the query string.
    const target = siteDataTarget(slug, path.split("?")[0]);
    const response = await respond(
      env,
      handleSiteDataRequest(target.slug, request, target.path, { from: target.from }),
    );
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
}

test("create, update, get, and list carry a version", async () => {
  const { env } = database();
  const call = client(env);
  const created = await call("POST", "games", { body: { winner: "A" } });
  assert.equal(created.status, 201);
  assert.equal(created.json.document.version, 1);
  const { id } = created.json.document;

  const updated = await call("PUT", `games/${id}`, {
    body: { winner: "B" },
    headers: { "if-match": "*" },
  });
  assert.equal(updated.json.document.version, 2);
  assert.deepEqual(updated.json.document.data, { winner: "B" });

  assert.equal((await call("GET", `games/${id}`)).json.document.version, 2);
  assert.equal((await call("GET", "games")).json.documents[0].version, 2);
});

test("If-Match with a stale version returns 409 and the current document", async () => {
  const { env } = database();
  const alice = client(env);
  const bob = client(env, { email: OTHER });
  const { id } = (await alice("POST", "answers", { body: { text: "a" } })).json.document;

  const first = await bob("PUT", `answers/${id}`, {
    body: { text: "bob" },
    headers: { "if-match": '"1"' },
  });
  assert.equal(first.status, 200);

  const stale = await alice("PUT", `answers/${id}`, {
    body: { text: "alice" },
    headers: { "if-match": '"1"' },
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.json.document.data, { text: "bob" });
  assert.equal(stale.json.document.updatedBy, OTHER);
  assert.equal(stale.json.document.version, 2);
});

test("update of a missing document is 404, put creates it, ifNew creates only once", async () => {
  const { env } = database();
  const call = client(env);
  const missing = await call("PUT", "answers/q3", {
    body: { text: "x" },
    headers: { "if-match": "*" },
  });
  assert.equal(missing.status, 404);

  const created = await call("PUT", "answers/q3", {
    body: { text: "x" },
    headers: { "if-none-match": "*" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.document.id, "q3");

  const again = await call("PUT", "answers/q3", {
    body: { text: "y" },
    headers: { "if-none-match": "*" },
  });
  assert.equal(again.status, 409);
  assert.deepEqual(again.json.document.data, { text: "x" });

  const replaced = await call("PUT", "answers/q3", { body: { text: "z" } });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.json.document.version, 2);
});

test("ids are scoped to the site and collection", async () => {
  const { env } = database();
  await client(env)("PUT", "answers/q3", { body: { site: "elo" } });
  await client(env)("PUT", "notes/q3", { body: { collection: "notes" } });
  await client(env, { slug: "other" })("PUT", "answers/q3", { body: { site: "other" } });
  assert.deepEqual((await client(env)("GET", "answers/q3")).json.document.data, { site: "elo" });
  assert.deepEqual((await client(env, { slug: "other" })("GET", "answers/q3")).json.document.data, {
    site: "other",
  });
});

test("patch merges fields atomically and honours If-Match", async () => {
  const { env } = database();
  const call = client(env);
  await call("PUT", "doc/main", { body: { a: 1, b: 2, nested: { x: 1 } } });
  const patched = await call("PATCH", "doc/main", { body: { b: null, c: 3, nested: { y: 2 } } });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.json.document.data, { a: 1, c: 3, nested: { x: 1, y: 2 } });
  assert.equal(patched.json.document.version, 2);

  const stale = await call("PATCH", "doc/main", { body: { a: 9 }, headers: { "if-match": '"1"' } });
  assert.equal(stale.status, 409);
  assert.equal((await call("PATCH", "doc/none", { body: { a: 1 } })).status, 404);

  const big = await call("PATCH", "doc/main", { body: { big: "x".repeat(60 * 1024) } });
  assert.equal(big.status, 200);
  const tooBig = await call("PATCH", "doc/main", { body: { more: "x".repeat(10 * 1024) } });
  assert.equal(tooBig.status, 413);
});

test("delete honours If-Match, and put brings a deleted document back with a higher version", async () => {
  const { env } = database();
  const call = client(env);
  await call("PUT", "doc/a", { body: { n: 1 } });
  assert.equal((await call("DELETE", "doc/a", { headers: { "if-match": '"7"' } })).status, 409);
  assert.equal((await call("DELETE", "doc/a", { headers: { "if-match": '"1"' } })).status, 204);
  assert.equal((await call("GET", "doc/a")).status, 404);
  assert.equal((await call("DELETE", "doc/a")).status, 404);
  assert.equal(
    (await call("PUT", "doc/a", { body: { n: 2 }, headers: { "if-match": '"2"' } })).status,
    404,
  );

  const back = await call("PUT", "doc/a", { body: { n: 3 }, headers: { "if-none-match": "*" } });
  assert.equal(back.status, 200);
  assert.equal(back.json.document.version, 3);
});

test("the changes feed returns writes and deletes after since, in order", async () => {
  const { env } = database();
  const call = client(env);
  await call("PUT", "doc/a", { body: { n: 1 } });
  await call("PUT", "doc/b", { body: { n: 1 } });
  await call("PUT", "other/z", { body: { n: 1 } });

  const all = await call("GET", "doc?since=0");
  assert.deepEqual(
    all.json.changes.map((c) => c.id),
    ["a", "b"],
  );
  const since = all.json.since;

  assert.deepEqual((await call("GET", `doc?since=${since}`)).json.changes, []);

  await call("PATCH", "doc/a", { body: { n: 2 } });
  await call("DELETE", "doc/b");
  const next = await call("GET", `doc?since=${since}`);
  assert.deepEqual(
    next.json.changes.map((c) => [c.id, c.version, Boolean(c.deleted)]),
    [
      ["a", 2, false],
      ["b", 2, true],
    ],
  );
  assert.equal(next.json.hasMore, false);

  const paged = await call("GET", `doc?since=${since}&limit=1`);
  assert.equal(paged.json.changes.length, 1);
  assert.equal(paged.json.hasMore, true);
  assert.equal((await call("GET", "doc?since=abc")).status, 400);
});

test("the changes feed from scratch leaves out deleted documents and skips past them", async () => {
  const { env } = database();
  const call = client(env);
  await call("PUT", "doc/a", { body: { n: 1 } });
  await call("PUT", "doc/b", { body: { n: 1 } });
  await call("PUT", "doc/c", { body: { n: 1 } });
  await call("DELETE", "doc/c");
  await call("DELETE", "doc/a");

  const all = await call("GET", "doc?since=0");
  assert.deepEqual(
    all.json.changes.map((c) => c.id),
    ["b"],
  );
  assert.equal(all.json.hasMore, false);
  // Nothing is left to read: the deletes after b are behind the returned since.
  assert.deepEqual((await call("GET", `doc?since=${all.json.since}`)).json.changes, []);

  // Later deletes still arrive.
  await call("DELETE", "doc/b");
  const next = await call("GET", `doc?since=${all.json.since}`);
  assert.deepEqual(
    next.json.changes.map((c) => [c.id, Boolean(c.deleted)]),
    [["b", true]],
  );
});

test("the changes feed sends up to 1000 changes a page", async () => {
  const { env } = database();
  const call = client(env);
  for (let i = 0; i < 120; i++) await call("POST", "doc", { body: { i } });
  const page = await call("GET", "doc?since=0&limit=1000");
  assert.equal(page.json.changes.length, 120);
  assert.equal(page.json.hasMore, false);
  const listed = await call("GET", "doc?limit=1000");
  assert.equal(listed.json.documents.length, 100);
});

test("another site's pages use a collection only when its nap.json allows them", async () => {
  const { env, sqlite } = database();
  sqlite.exec(`INSERT INTO sites (slug, title, created_by_email, updated_by_email, current_version,
      sort_order, visibility)
      VALUES ('secret', 'Secret', '${OTHER}', '${OTHER}', 'v1', 3, 'private')`);
  const elo = client(env);
  const other = client(env, { slug: "other" });

  const put = await other("PUT", "@elo/scores/g1", { body: { score: 3 } });
  assert.equal(put.status, 201);
  assert.equal(put.json.document.createdBy, OWNER);
  // It lands in elo's collection, not the other site's.
  assert.deepEqual((await elo("GET", "scores/g1")).json.document.data, { score: 3 });
  assert.equal((await other("GET", "scores/g1")).status, 404);

  const patched = await other("PATCH", "@elo/scores/g1", {
    body: { score: 4 },
    headers: { "if-match": '"1"' },
  });
  assert.equal(patched.json.document.version, 2);
  const stale = await other("PUT", "@elo/scores/g1", {
    body: { score: 5 },
    headers: { "if-match": '"1"' },
  });
  assert.equal(stale.status, 409);
  assert.equal((await other("GET", "@elo/scores")).json.documents.length, 1);
  assert.equal((await other("GET", "@elo/scores?since=0")).json.changes.length, 1);
  assert.equal((await other("DELETE", "@elo/scores/g1")).status, 204);

  // A collection it does not list, and a site it does not list.
  const denied = await other("GET", "@elo/games");
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /"data": \{ "allow": \{ "other": \["games"\] \} \}/);
  assert.equal((await elo("GET", "@other/scores")).status, 403);
  // A site the person cannot view, or that does not exist, is not found.
  assert.equal((await other("GET", "@secret/scores")).status, 404);
  assert.equal((await other("GET", "@nope/scores")).status, 404);
  // @<own slug> is the site's own collection.
  assert.equal((await elo("GET", "@elo/games")).status, 200);
});

test("bad ids and conditions are rejected", async () => {
  const { env } = database();
  const call = client(env);
  assert.equal((await call("PUT", "doc/-bad", { body: {} })).status, 400);
  assert.equal((await call("PUT", `doc/${"a".repeat(65)}`, { body: {} })).status, 400);
  assert.equal(
    (await call("PUT", "doc/a", { body: {}, headers: { "if-match": "nope" } })).status,
    400,
  );
});

test("the migration keeps documents and numbers them per site", async () => {
  const { sqlite } = database({ before: "0015_document_versions.sql" });
  sqlite.exec(`INSERT INTO site_documents
      (id, site_slug, collection, data_json, created_by_email, updated_by_email, updated_at, deleted_at)
    VALUES
      ('11111111-1111-1111-1111-111111111111', 'elo', 'games', '{"n":1}', '${OWNER}', '${OWNER}', '2026-01-02', NULL),
      ('22222222-2222-2222-2222-222222222222', 'elo', 'games', '{"n":2}', '${OWNER}', '${OWNER}', '2026-01-01', NULL),
      ('33333333-3333-3333-3333-333333333333', 'other', 'x', '{}', '${OWNER}', '${OWNER}', '2026-01-01', '2026-01-03')`);
  sqlite.exec(readFileSync("migrations/0015_document_versions.sql", "utf8"));
  const rows = sqlite
    .prepare(
      "SELECT id, site_slug, version, seq, deleted_at FROM site_documents ORDER BY site_slug, seq",
    )
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    {
      id: "22222222-2222-2222-2222-222222222222",
      site_slug: "elo",
      version: 1,
      seq: 1,
      deleted_at: null,
    },
    {
      id: "11111111-1111-1111-1111-111111111111",
      site_slug: "elo",
      version: 1,
      seq: 2,
      deleted_at: null,
    },
    {
      id: "33333333-3333-3333-3333-333333333333",
      site_slug: "other",
      version: 1,
      seq: 1,
      deleted_at: "2026-01-03",
    },
  ]);
});

/** /_nap/client.js, built once, as the Worker serves it. */
let built;
function clientSource() {
  built ??= import("../scripts/lib/client-bundle.ts").then(async ({ bundleClient }) => {
    return (await bundleClient()).client;
  });
  return built;
}

/** Runs the served client.js against the handler, as one page of the elo site. */
async function page(env, email = OWNER, WebSocket = undefined, slug = "elo") {
  const source = await clientSource();
  const window = {};
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const location = new URL(`https://${slug}.nap.test/`);
  const fetch = (path, options = {}) => {
    const url = new URL(path, location);
    const request = new Request(url, {
      ...options,
      headers: { ...options.headers, "cf-access-authenticated-user-email": email },
    });
    const target = siteDataTarget(slug, url.pathname.slice("/_nap/data/".length));
    return respond(
      env,
      handleSiteDataRequest(target.slug, request, target.path, { from: target.from }),
    );
  };
  new Function("window", "document", "location", "fetch", "WebSocket", source)(
    window,
    document,
    location,
    fetch,
    WebSocket,
  );
  return window.nap;
}

const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check());
};

test("the client: conflicts carry the current document, subscribe sees every page's writes", async () => {
  const { env } = database();
  const alice = (await page(env)).db.collection("answers");
  const bobNap = await page(env, OTHER);
  const bob = bobNap.db.collection("answers");

  const first = await alice.put("q3", { text: "a" }, { ifNew: true });
  await bob.update("q3", { text: "bob" }, { ifVersion: first.version });
  const error = await alice
    .update("q3", { text: "alice" }, { ifVersion: first.version })
    .catch((e) => e);
  assert.ok(error instanceof bobNap.NapError || error.name === "NapError");
  assert.equal(error.status, 409);
  assert.deepEqual(error.document.data, { text: "bob" });

  const seen = [];
  const stop = alice.subscribe((docs) => seen.push(docs.map((d) => `${d.id}:${d.data.text}`)), {
    interval: 1000,
  });
  await until(() => seen.length === 1);
  assert.deepEqual(seen[0], ["q3:bob"]);

  // A write from this page shows at once.
  await alice.put("q4", { text: "four" });
  assert.deepEqual(seen.at(-1), ["q4:four", "q3:bob"]);
  await alice.delete("q4");
  assert.deepEqual(seen.at(-1), ["q3:bob"]);
  // Re-creating a deleted id works.
  await alice.put("q4", { text: "again" });
  assert.deepEqual(seen.at(-1), ["q4:again", "q3:bob"]);

  // A write from another page arrives on the next poll.
  await bob.patch("q3", { text: "bob2" });
  await until(() => seen.at(-1).includes("q3:bob2"));
  stop();
});

test("the client: changes pushed over the live socket reach subscribers", async () => {
  const { env } = database();
  const sockets = [];
  class FakeSocket {
    readyState = 1;
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    send() {}
    close(code) {
      this.readyState = 3;
      this.onclose?.({ code });
    }
  }
  const nap = await page(env, OWNER, FakeSocket);
  const answers = nap.db.collection("answers");
  const seen = [];
  const stop = answers.subscribe((docs) => seen.push(docs.map((d) => d.data.text)));
  await until(() => seen.length === 1);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "wss://elo.nap.test/_nap/live");
  sockets[0].onopen();

  const change = (version, text) => ({
    data: JSON.stringify({
      type: "change",
      collection: "answers",
      change: { id: "q1", version, data: { text }, createdAt: "2026-01-01T00:00:00Z" },
    }),
  });
  sockets[0].onmessage(change(2, "new"));
  assert.deepEqual(seen.at(-1), ["new"]);
  // An older change that arrives late is ignored.
  sockets[0].onmessage(change(1, "old"));
  assert.deepEqual(seen.at(-1), ["new"]);
  sockets[0].onmessage({
    data: JSON.stringify({
      type: "change",
      collection: "answers",
      change: { id: "q1", version: 3, deleted: true },
    }),
  });
  assert.deepEqual(seen.at(-1), []);
  stop();
});

test("the client: another site's collection, without subscribe", async () => {
  const { env } = database();
  const elo = (await page(env)).db.collection("scores");
  const nap = await page(env, OWNER, undefined, "other");
  const scores = nap.db.collection("scores", { site: "elo" });

  const saved = await scores.put("g1", { score: 7 }, { ifNew: true });
  assert.equal(saved.version, 1);
  assert.deepEqual((await elo.get("g1")).data, { score: 7 });
  await scores.patch("g1", { score: 8 }, { ifVersion: 1 });
  assert.deepEqual(
    (await scores.list()).documents.map((d) => d.data.score),
    [8],
  );
  assert.equal((await scores.changes()).changes.length, 1);

  assert.throws(() => scores.subscribe(() => {}), /not available for another site/);
  assert.throws(() => nap.db.collection("scores", { site: "Bad/../x" }), /Invalid Nap site/);
  const error = await nap.db
    .collection("games", { site: "elo" })
    .list()
    .catch((e) => e);
  assert.equal(error.status, 403);
});

test("viewersAmong follows the same access rule as reads", async () => {
  const { sqlite, env } = database();
  const all = [OWNER.toUpperCase(), OTHER, "x@example.com"];
  assert.deepEqual([...(await viewersAmong(env, "elo", all))].sort(), [
    OTHER,
    OWNER,
    "x@example.com",
  ]);
  sqlite.exec(`UPDATE sites SET visibility = 'selected' WHERE slug = 'elo';
    INSERT INTO site_viewers (site_slug, email) VALUES ('elo', '${OTHER}')`);
  assert.deepEqual([...(await viewersAmong(env, "elo", all))].sort(), [OTHER, OWNER]);
  sqlite.exec(`UPDATE sites SET visibility = 'private' WHERE slug = 'elo'`);
  assert.deepEqual([...(await viewersAmong(env, "elo", all))], [OWNER]);
  assert.deepEqual([...(await viewersAmong(env, "gone", all))], []);
});

test("the client: channels track peers, presence, messages, and the host", async () => {
  const { env } = database();
  const sockets = [];
  class FakeSocket {
    readyState = 1;
    sent = [];
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    send(text) {
      this.sent.push(text);
    }
    close(code) {
      this.readyState = 3;
      this.onclose?.({ code });
    }
    receive(message) {
      this.onmessage({ data: JSON.stringify(message) });
    }
  }
  const nap = await page(env, OWNER, FakeSocket);
  const world = nap.channel("world");
  assert.equal(nap.channel("world"), world, "one object per channel name");
  assert.throws(() => nap.channel("bad name"), TypeError);
  assert.equal(sockets[0].url, "wss://elo.nap.test/_nap/channel/world");

  const seen = [];
  world.on("presence", (peers) => seen.push(peers.map((p) => [p.id, p.self, p.state])));
  const messages = [];
  world.on("message", (m) => messages.push(m));

  world.setPresence({ x: 1 }); // Before connecting: sent on welcome.
  sockets[0].receive({
    t: "welcome",
    id: "me",
    peers: [
      { id: "old", email: OTHER, name: "Other", joinedAt: 1, state: { x: 9 } },
      { id: "me", email: OWNER, name: "Owner", joinedAt: 2, state: null },
    ],
  });
  assert.equal(world.status, "open");
  assert.deepEqual(seen.at(-1), [
    ["old", false, { x: 9 }],
    ["me", true, { x: 1 }],
  ]);
  assert.deepEqual(JSON.parse(sockets[0].sent.at(-1)), { t: "presence", state: { x: 1 } });
  assert.equal(world.host.id, "old");
  assert.equal(world.isHost, false);

  sockets[0].receive({ t: "presence", id: "old", state: { x: 10 } });
  assert.deepEqual(seen.at(-1)[0], ["old", false, { x: 10 }]);
  sockets[0].receive({ t: "message", from: { id: "old" }, data: { kick: 1 } });
  assert.equal(messages[0].from.name, "Other");
  assert.deepEqual(messages[0].data, { kick: 1 });

  assert.equal(world.send({ hi: 1 }, { to: "old" }), true);
  assert.deepEqual(JSON.parse(sockets[0].sent.at(-1)), { t: "send", data: { hi: 1 }, to: "old" });

  sockets[0].receive({ t: "leave", id: "old" });
  assert.equal(world.isHost, true, "the next oldest peer becomes host");

  world.leave();
  assert.equal(world.status, "closed");
  assert.notEqual(nap.channel("world"), world, "a new object after leave");
  nap.channel("world").leave();
});
