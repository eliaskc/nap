import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

// publish.ts reaches nap-server.ts, which imports the Workers runtime and uses the ~/ alias.
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
const { checkSourceCommit, createSource, describeSource, isAncestor, mintSourceToken } =
  await import("../src/lib/sources.ts");
const { publishFiles } = await import("../src/lib/publish.ts");
const { restoreVersion } = await import("../src/lib/versions.ts");
const { runNap } = await import("../src/server/runtime.ts");
const { recoverHttpError } = await import("../src/server/http.ts");
const { Effect } = await import("effect");

/** Runs a Nap effect: its value, or the error response for an HttpError. */
const call = (env, effect) => runNap(env, recoverHttpError(effect));

const OWNER = "owner@example.com";
const OTHER = "other@example.com";
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
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function database({ until } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    if (file === until) break;
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  return sqlite;
}

/** An in-memory Artifacts namespace: commits with parents, and a main branch. */
function artifacts() {
  const repos = new Map();
  const tokens = [];
  const handle = (name) => {
    const repo = repos.get(name);
    const remote = `https://acct.artifacts.cloudflare.net/git/nap-sites/${name}.git`;
    return {
      // Like the runtime: no metadata properties on the handle, only info().
      async info() {
        return { name, remote, defaultBranch: "main" };
      },
      async createToken(scope, ttl) {
        const token = { plaintext: `art_v2_${scope}_${tokens.length}`, scope, ttl };
        tokens.push(token);
        return { plaintext: token.plaintext, expiresAt: new Date(ttl * 1000).toISOString() };
      },
      async revokeToken(value) {
        const token = tokens.find((t) => t.plaintext === value);
        if (token) token.revoked = true;
        return Boolean(token);
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
    tokens,
    async create(name) {
      if (repos.has(name)) throw Object.assign(new Error("exists"), { code: "ALREADY_EXISTS" });
      repos.set(name, { commits: new Map(), main: null });
      return { name, remote: (await handle(name).info()).remote, token: "art_v2_initial" };
    },
    async get(name) {
      if (!repos.has(name)) throw Object.assign(new Error("missing"), { code: "NOT_FOUND" });
      return handle(name);
    },
    async delete(name) {
      return repos.delete(name);
    },
    /** Test helper: add a commit and optionally move main to it. */
    commit(name, hash, parents = [], { main = true } = {}) {
      const repo = repos.get(name);
      repo.commits.set(hash, parents);
      if (main) repo.main = hash;
    },
  };
}

function setup() {
  const sqlite = database();
  sqlite.exec(`INSERT INTO profiles (email) VALUES ('${OWNER}'), ('${OTHER}');
    INSERT INTO sites (slug, title, created_by_email, updated_by_email, current_version,
      sort_order, visibility)
      VALUES ('elo', 'Elo', '${OWNER}', '${OWNER}', 'v1', 1, 'everyone');
    INSERT INTO versions (id, site_slug, uploaded_by_email, file_count, total_bytes, source)
      VALUES ('v1', 'elo', '${OWNER}', 1, 10, 'agent');`);
  const objects = new Map();
  const SITES = {
    async put(key, body) {
      objects.set(key, body);
    },
  };
  const SOURCES = artifacts();
  return { sqlite, objects, SOURCES, env: { DB: d1(sqlite), SITES, SOURCES } };
}

const site = (sqlite, slug = "elo") =>
  sqlite
    .prepare(
      "SELECT slug, title, source_repo AS sourceRepo, current_version AS currentVersion FROM sites WHERE slug = ?",
    )
    .get(slug);

const file = () => ({
  path: "index.html",
  body: new Blob(["<title>Elo</title>"], { type: "text/html" }),
});

function publish(env, { email = OWNER, sourceCommit, expected } = {}) {
  return call(
    env,
    publishFiles(
      { email, name: "" },
      {
        files: [file()],
        targetSlug: "elo",
        requireExpectedVersion: true,
        expectedCurrentVersion: expected ?? null,
        source: "agent",
        sourceCommit,
      },
    ),
  );
}

test("migration 0016 turns GitHub-managed sites into ordinary sites", () => {
  const sqlite = database({ until: "0016_site_sources.sql" });
  sqlite.exec(`INSERT INTO profiles (email) VALUES ('${OWNER}');
    INSERT INTO sites (slug, title, created_by_email, updated_by_email, current_version,
      sort_order, management_type, source_repository, source_directory)
      VALUES ('elo', 'Elo', '${OWNER}', '${OWNER}', 'v1', 1, 'github', 'example/sites', 'sites/elo');
    INSERT INTO site_deployments (site_slug, run_number, source_commit, fingerprint, status)
      VALUES ('elo', 1, 'abc', 'f', 'deployed');`);
  assert.throws(() => sqlite.exec("DELETE FROM sites WHERE slug = 'elo'"), /cannot be deleted/);
  sqlite.exec(readFileSync("migrations/0016_site_sources.sql", "utf8"));
  assert.deepEqual(
    {
      ...sqlite
        .prepare(
          "SELECT management_type, source_repository, source_directory, source_repo FROM sites",
        )
        .get(),
    },
    {
      management_type: "direct",
      source_repository: null,
      source_directory: null,
      source_repo: null,
    },
  );
  assert.equal(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'site_deployments'").get(),
    undefined,
  );
  sqlite.exec("UPDATE sites SET slug = 'elo-2' WHERE slug = 'elo'");
  sqlite.exec("DELETE FROM sites");
});

test("isAncestor follows merges, not just the first-parent line", async () => {
  const ns = artifacts();
  await ns.create("r");
  ns.commit("r", sha(1));
  ns.commit("r", sha(2), [sha(1)]); // pushed by someone else, and live
  ns.commit("r", sha(3), [sha(1)], { main: false }); // local work
  ns.commit("r", sha(4), [sha(3), sha(2)]); // git pull --no-rebase
  ns.commit("r", sha(5), [sha(1)], { main: false }); // a force-push that drops sha(2)
  const repo = await ns.get("r");
  assert.equal(await Effect.runPromise(isAncestor(repo, sha(2), sha(4))), true);
  assert.equal(await Effect.runPromise(isAncestor(repo, sha(1), sha(4))), true);
  assert.equal(await Effect.runPromise(isAncestor(repo, sha(4), sha(4))), true);
  assert.equal(await Effect.runPromise(isAncestor(repo, sha(2), sha(5))), false);
});

test("createSource names the repo after the site, records it once, and mints a short token", async () => {
  const { env, sqlite, SOURCES } = setup();
  await SOURCES.create("elo"); // an old repo from a deleted site
  const access = await call(env, createSource(site(sqlite)));
  assert.match(access.repo, /^elo-[a-z0-9]{1,6}$/);
  assert.equal(site(sqlite).sourceRepo, access.repo);
  assert.equal(access.scope, "write");
  assert.equal(access.branch, "main");
  assert.match(access.remote, /\/nap-sites\/elo-[a-z0-9]+\.git$/);
  assert.equal(SOURCES.tokens.at(-1).ttl, 15 * 60);

  const again = await call(env, createSource({ ...site(sqlite), slug: "elo" }));
  assert.equal(again.status, 409);
  assert.equal(SOURCES.repos.size, 2, "the losing repo is deleted");

  const read = await call(env, mintSourceToken(access.repo, "read"));
  assert.equal(read.scope, "read");
  const missing = await call({ DB: env.DB }, mintSourceToken(access.repo, "read"));
  assert.equal(missing.status, 503);
});

test("a site with a source repo only publishes the head of main, containing the live commit", async () => {
  const { env, sqlite, SOURCES, objects } = setup();
  const { repo } = await call(env, createSource(site(sqlite)));

  // No commit: dashboard uploads, claims, and agents that forgot it.
  let result = await publish(env);
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, "source_commit_required");

  // Nothing pushed yet.
  result = await publish(env, { sourceCommit: sha(1) });
  assert.equal((await result.json()).code, "source_not_head");

  SOURCES.commit(repo, sha(1));
  result = await publish(env, { sourceCommit: "not-a-hash" });
  assert.equal((await result.json()).code, "invalid_source_commit");

  result = await publish(env, { sourceCommit: sha(1).toUpperCase() });
  assert.equal(result.created, false);
  const v2 = result.currentVersion;
  assert.equal(
    sqlite.prepare("SELECT source_commit FROM versions WHERE id = ?").get(v2).source_commit,
    sha(1),
  );
  assert.ok([...objects.keys()].some((key) => key.startsWith(`sites/elo/versions/${v2}/`)));

  // Someone pushed after us: our commit is no longer the head.
  SOURCES.commit(repo, sha(2), [sha(1)]);
  result = await publish(env, { sourceCommit: sha(1) });
  const stale = await result.json();
  assert.equal(stale.code, "source_not_head");
  assert.equal(stale.head, sha(2));

  // A force-push that drops the live commit cannot go live.
  SOURCES.commit(repo, sha(9), []);
  result = await publish(env, { sourceCommit: sha(9) });
  const dropped = await result.json();
  assert.equal(dropped.code, "source_not_descendant");
  assert.equal(dropped.liveCommit, sha(1));
  assert.equal(site(sqlite).currentVersion, v2);

  // Someone else publishes: they still need the live version they read.
  SOURCES.commit(repo, sha(3), [sha(1)]);
  result = await publish(env, { email: OTHER, sourceCommit: sha(3) });
  assert.equal((await result.json()).code, "expected_version_required");
  result = await publish(env, { email: OTHER, sourceCommit: sha(3), expected: v2 });
  assert.equal(result.created, false);

  // A restore leaves main ahead; the next publish of main still works.
  const restored = await call(env, restoreVersion(OWNER, "elo", { version: v2 }));
  assert.equal(restored.status, 200);
  const described = await call(env, describeSource(site(sqlite)));
  assert.deepEqual(
    { head: described.head, liveCommit: described.liveCommit, inSync: described.inSync },
    { head: sha(3), liveCommit: sha(1), inSync: false },
  );
  result = await publish(env, { sourceCommit: sha(3) });
  assert.equal(result.created, false);
});

test("sites without a source repo publish as before and refuse a commit", async () => {
  const { env } = setup();
  const result = await publish(env);
  assert.equal(result.created, false);
  const refused = await publish(env, { sourceCommit: sha(1) });
  assert.equal((await refused.json()).code, "no_source_repo");
  assert.equal(await call(env, checkSourceCommit(null, "")), undefined);
});

const { startDirectUpload, commitDirectUpload } = await import("../src/lib/direct-uploads.ts");

function uploadEnv() {
  const { env, sqlite, SOURCES, objects } = setup();
  const SITES = {
    ...env.SITES,
    async list({ prefix }) {
      const listed = [...objects.keys()].filter((key) => key.startsWith(prefix));
      return { objects: listed.map((key) => ({ key, size: objects.get(key) })), truncated: false };
    },
    // Only the manifests are read back; version files are stored as their sizes.
    async get(key) {
      const value = objects.get(key);
      return typeof value === "string" ? { text: async () => value } : null;
    },
    async delete(keys) {
      for (const key of [keys].flat()) objects.delete(key);
    },
  };
  const credentials = {
    NAP_R2_ACCOUNT_ID: "acct",
    NAP_R2_BUCKET: "bucket",
    NAP_R2_ACCESS_KEY_ID: "key",
    NAP_R2_SECRET_ACCESS_KEY: "secret",
  };
  return { sqlite, SOURCES, objects, env: { ...env, ...credentials, SITES } };
}

const startNewSite = (env, input = {}) =>
  call(
    env,
    startDirectUpload(
      { email: OWNER, name: "" },
      {
        files: [{ path: "index.html", size: 18 }],
        targetSlug: null,
        requireExpectedVersion: true,
        expectedCurrentVersion: null,
        kind: "site",
        slug: "team-map",
        title: "Team map",
        source: "agent",
        createSource: true,
        sourceCommit: sha(1),
        ...input,
      },
    ),
  );

test("a new site gets its source repo with its first upload, built from a commit", async () => {
  const { env, sqlite, SOURCES, objects } = uploadEnv();
  const { uploadId, source } = await startNewSite(env);
  assert.equal(source.repo, "team-map");
  assert.equal(source.scope, "write");
  assert.equal(site(sqlite, "team-map"), undefined, "no site until the upload is committed");

  const [{ version_id: versionId }] = sqlite.prepare("SELECT version_id FROM uploads").all();
  objects.set(`sites/team-map/versions/${versionId}/index.html`, 18);

  // Not pushed yet: the upload and its repo stay, so the agent can push and commit again.
  const early = await call(env, commitDirectUpload({ email: OWNER, name: "" }, uploadId, "agent"));
  assert.equal((await early.json()).code, "source_not_head");
  assert.ok(SOURCES.repos.has("team-map"));

  SOURCES.commit("team-map", sha(1));
  const published = await call(
    env,
    commitDirectUpload({ email: OWNER, name: "" }, uploadId, "agent"),
  );
  assert.equal(published.created, true);
  assert.equal(site(sqlite, "team-map").sourceRepo, "team-map");
  assert.equal(
    sqlite.prepare("SELECT source_commit FROM versions WHERE id = ?").get(versionId).source_commit,
    sha(1),
  );
});

test("createSource is only for new sites, with a commit", async () => {
  const { env, SOURCES } = uploadEnv();
  let result = await startNewSite(env, { sourceCommit: "" });
  assert.equal((await result.json()).code, "invalid_source_commit");
  result = await startNewSite(env, { kind: "artifact", slug: "" });
  assert.equal((await result.json()).code, "create_source_new_sites_only");
  result = await startNewSite(env, { targetSlug: "elo", kind: undefined, slug: "" });
  assert.equal((await result.json()).code, "create_source_new_sites_only");
  assert.equal(SOURCES.repos.size, 0);
});

test("an expired upload deletes the repo it created", async () => {
  const { env, sqlite, SOURCES } = uploadEnv();
  await startNewSite(env);
  assert.ok(SOURCES.repos.has("team-map"));
  sqlite.exec("UPDATE uploads SET expires_at = '2000-01-01T00:00:00.000Z'");
  await startNewSite(env, { slug: "other", createSource: false, sourceCommit: null });
  assert.equal(SOURCES.repos.has("team-map"), false);
});

const { SIGNED_PAGE_BYTES, SIGNED_PAGE_SIZE, signDirectUploadPage } =
  await import("../src/lib/direct-uploads.ts");

const startFiles = (env, files) =>
  call(
    env,
    startDirectUpload(
      { email: OWNER, name: "" },
      {
        files,
        targetSlug: null,
        requireExpectedVersion: true,
        expectedCurrentVersion: null,
        kind: "artifact",
        source: "agent",
      },
    ),
  );

const tiles = (count) => [
  { path: "index.html", size: 18 },
  ...Array.from({ length: count - 1 }, (_, i) => ({ path: `tiles/${i}.png`, size: 100 + (i % 7) })),
];

test("a direct upload of many files signs its URLs a page at a time", async () => {
  const { env, sqlite, objects } = uploadEnv();
  const files = tiles(2 * SIGNED_PAGE_SIZE + 500);
  const started = await startFiles(env, files);
  assert.equal(started.fileCount, files.length);
  assert.equal(started.files.length, SIGNED_PAGE_SIZE);
  assert.equal(started.nextOffset, SIGNED_PAGE_SIZE);
  assert.ok(objects.has(`uploads/${started.uploadId}/manifest.json`), "the manifest is in R2");
  assert.equal(
    sqlite.prepare("SELECT name FROM pragma_table_info('uploads') WHERE name = 'files_json'").get(),
    undefined,
    "not in D1",
  );

  const agent = { email: OWNER, name: "" };
  const signed = [...started.files];
  let offset = started.nextOffset;
  sqlite.exec("UPDATE uploads SET expires_at = '2999-01-01T00:00:00.000Z'");
  while (offset !== null) {
    const page = await call(env, signDirectUploadPage(agent, started.uploadId, "agent", offset));
    signed.push(...page.files);
    offset = page.nextOffset;
  }
  assert.deepEqual(
    signed.map((file) => file.path),
    files.map((file) => file.path),
    "every file once, in order",
  );
  const [{ expires_at: expiresAt }] = sqlite.prepare("SELECT expires_at FROM uploads").all();
  assert.ok(expiresAt < "2999", "asking for a page moves the expiry");

  for (const [bad, why] of [
    [files.length, "past the end"],
    [-1, "negative"],
    [Number.NaN, "missing"],
  ]) {
    const refused = await call(env, signDirectUploadPage(agent, started.uploadId, "agent", bad));
    assert.equal(refused.status, 400, why);
  }
  const other = await call(
    env,
    signDirectUploadPage({ email: OTHER, name: "" }, started.uploadId, "agent", 0),
  );
  assert.equal(other.status, 404, "owner only");

  // Commit checks the whole manifest, not just the first page.
  const [{ version_id: versionId }] = sqlite.prepare("SELECT version_id FROM uploads").all();
  const prefix = `sites/${started.id}/versions/${versionId}/`;
  for (const file of files.slice(0, -1)) objects.set(prefix + file.path, file.size);
  const early = await call(env, commitDirectUpload(agent, started.uploadId, "agent"));
  assert.equal(early.status, 409);
  assert.deepEqual((await early.json()).missing, [files.at(-1).path]);

  objects.set(prefix + files.at(-1).path, files.at(-1).size);
  const published = await call(env, commitDirectUpload(agent, started.uploadId, "agent"));
  assert.equal(published.created, true);
  assert.equal(
    sqlite.prepare("SELECT file_count FROM versions WHERE id = ?").get(versionId).file_count,
    files.length,
  );
  assert.equal(objects.has(`uploads/${started.uploadId}/manifest.json`), false, "manifest gone");
  const again = await call(env, signDirectUploadPage(agent, started.uploadId, "agent", 0));
  assert.equal(again.status, 409, "no URLs after the commit");
});

test("direct uploads take up to 100,000 files", async () => {
  const { env } = uploadEnv();
  const started = await startFiles(env, tiles(100_000));
  assert.equal(started.fileCount, 100_000);
  const refused = await startFiles(env, tiles(100_001));
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /max 100,000/);
});

test("an expired upload deletes its manifest", async () => {
  const { env, sqlite, objects } = uploadEnv();
  const started = await startFiles(env, tiles(3));
  sqlite.exec("UPDATE uploads SET expires_at = '2000-01-01T00:00:00.000Z'");
  await startFiles(env, tiles(2));
  assert.equal(objects.has(`uploads/${started.uploadId}/manifest.json`), false);
});

test("pages also stop at SIGNED_PAGE_BYTES, and a larger file gets a page of its own", async () => {
  const { env, sqlite } = uploadEnv();
  const third = Math.floor(SIGNED_PAGE_BYTES / 3);
  const files = [
    { path: "index.html", size: 18 },
    { path: "a.bin", size: third },
    { path: "b.bin", size: third },
    { path: "c.bin", size: third },
    { path: "huge.bin", size: 3 * SIGNED_PAGE_BYTES },
    { path: "d.bin", size: 1 },
  ];
  const started = await startFiles(env, files);
  const pages = [started.files.map((file) => file.path)];
  let offset = started.nextOffset;
  while (offset !== null) {
    const page = await call(
      env,
      signDirectUploadPage({ email: OWNER, name: "" }, started.uploadId, "agent", offset),
    );
    pages.push(page.files.map((file) => file.path));
    offset = page.nextOffset;
  }
  assert.deepEqual(pages, [["index.html", "a.bin", "b.bin"], ["c.bin"], ["huge.bin"], ["d.bin"]]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM uploads").get().n, 1);
});

test("direct uploads take 10 GB, with up to 4 GB a file", async () => {
  const { env } = uploadEnv();
  const gb = 1024 ** 3;
  const ok = await startFiles(env, [
    { path: "index.html", size: 1 },
    { path: "a.bin", size: 4 * gb },
    { path: "b.bin", size: 4 * gb },
    { path: "c.bin", size: 2 * gb - 1 },
  ]);
  assert.equal(ok.totalBytes, 10 * gb);
  const total = await startFiles(env, [
    { path: "index.html", size: 2 },
    { path: "a.bin", size: 4 * gb },
    { path: "b.bin", size: 4 * gb },
    { path: "c.bin", size: 2 * gb - 1 },
  ]);
  assert.equal(total.status, 413);
  const one = await startFiles(env, [
    { path: "index.html", size: 1 },
    { path: "big.bin", size: 4 * gb + 1 },
  ]);
  assert.equal(one.status, 413);
  assert.match((await one.json()).error, /big\.bin is larger than 4 GB/);
});
