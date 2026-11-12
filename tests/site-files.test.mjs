import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

// site-files.ts reaches nap-server.ts, which imports the Workers runtime and uses the ~/ alias.
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
const { handleSiteFilesRequest, deleteSiteFiles, notificationImageUrl, MAX_FILE_BYTES } =
  await import("../src/lib/site-files.ts");
const { respond, runNap } = await import("../src/server/runtime.ts");

const OWNER = "owner@example.com";
const OTHER = "other@example.com";

/** R2 with what files use: metadata, etags, and listing. */
function bucket() {
  const objects = new Map();
  const object = (key, entry) => ({
    key,
    size: entry.bytes.byteLength,
    httpEtag: `"${entry.etag}"`,
    uploaded: entry.uploaded,
    httpMetadata: entry.options?.httpMetadata ?? {},
    customMetadata: entry.options?.customMetadata ?? {},
  });
  let n = 0;
  return {
    objects,
    async put(key, body, options) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const entry = { bytes, options, etag: `e${++n}`, uploaded: new Date() };
      objects.set(key, entry);
      return object(key, entry);
    },
    async get(key) {
      const entry = objects.get(key);
      if (!entry) return null;
      return { ...object(key, entry), body: new Response(entry.bytes).body };
    },
    async head(key) {
      const entry = objects.get(key);
      return entry ? object(key, entry) : null;
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

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO profiles (email) VALUES ('${OWNER}'), ('${OTHER}');
    INSERT INTO sites (slug, title, created_by_email, updated_by_email, current_version, sort_order,
      visibility)
      VALUES ('quiz', 'Quiz', '${OWNER}', '${OWNER}', 'v1', 1, 'private');`);
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
  const SITES = bucket();
  return { env: { DB, SITES }, SITES };
}

/** A request on the site's host, as `email` (through Access), or with a token (`identity`). */
function client(env, { email = OWNER, token = false } = {}) {
  return async (method, path = "", { body, headers = {} } = {}) => {
    const request = new Request(`https://quiz.nap.test/_nap/files${path}`, {
      method,
      headers: token ? headers : { "cf-access-authenticated-user-email": email, ...headers },
      body,
    });
    return respond(
      env,
      handleSiteFilesRequest("quiz", request, path, {
        ...(token ? { identity: { email, name: email } } : {}),
      }),
    );
  };
}

test("upload, read, and delete a file: its type, name, and who uploaded it", async () => {
  const { env, SITES } = setup();
  const call = client(env);
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
  const uploaded = await call("POST", "", {
    body: photo,
    headers: { "content-type": "image/jpeg", "x-nap-file-name": "kv%C3%A4ll.jpg" },
  });
  assert.equal(uploaded.status, 201);
  const { file } = await uploaded.json();
  assert.match(file.id, /^[a-z0-9]{24}$/);
  assert.equal(file.type, "image/jpeg");
  assert.equal(file.size, 6);
  assert.equal(file.name, "kväll.jpg");
  assert.equal(file.createdBy, OWNER);
  assert.ok(Date.parse(file.createdAt));
  assert.ok(SITES.objects.has(`files/quiz/${file.id}`));

  const read = await call("GET", `/${file.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("content-type"), "image/jpeg");
  assert.equal(read.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(read.headers.get("content-security-policy"), "sandbox");
  assert.match(read.headers.get("content-disposition"), /filename\*=UTF-8''kv%C3%A4ll\.jpg/);
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), photo);
  const head = await call("HEAD", `/${file.id}`);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "6");
  const again = await call("GET", `/${file.id}`, {
    headers: { "if-none-match": read.headers.get("etag") },
  });
  assert.equal(again.status, 304);

  assert.equal((await call("DELETE", `/${file.id}`)).status, 204);
  assert.equal((await call("GET", `/${file.id}`)).status, 404);
  assert.equal((await call("DELETE", `/${file.id}`)).status, 404);
  assert.equal((await call("GET", "/../other")).status, 404);
});

test("only people who can view the site, and writes only from its own pages", async () => {
  const { env } = setup();
  const stranger = client(env, { email: OTHER });
  const denied = await stranger("POST", "", {
    body: "x",
    headers: { "content-type": "text/plain" },
  });
  assert.equal(denied.status, 404);
  const owner = client(env);
  const crossSite = await owner("POST", "", {
    body: "x",
    headers: { "content-type": "text/plain", "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossSite.status, 403);
  // Tokens (apps) do not come from a browser page.
  const app = client(env, { token: true });
  const fromApp = await app("POST", "", { body: "x", headers: { "content-type": "text/plain" } });
  assert.equal(fromApp.status, 201);
  const { file } = await fromApp.json();
  assert.equal(file.name, null);
  assert.equal((await stranger("GET", `/${file.id}`)).status, 404);
});

test("files are up to 15 MB, and need a body and a sensible type", async () => {
  const { env } = setup();
  const call = client(env);
  const big = await call("POST", "", {
    body: new Uint8Array(MAX_FILE_BYTES + 1),
    headers: { "content-type": "application/octet-stream" },
  });
  assert.equal(big.status, 413);
  const empty = await call("POST", "", { body: "", headers: { "content-type": "image/png" } });
  assert.equal(empty.status, 400);
  const badType = await call("POST", "", { body: "x", headers: { "content-type": "not a type" } });
  assert.equal(badType.status, 400);
  assert.equal((await call("PUT", "")).status, 405);
});

test("notification images: presigned for 7 days, only image files of the site", async () => {
  const { env } = setup();
  const call = client(env);
  const upload = async (type) =>
    (await (await call("POST", "", { body: "x", headers: { "content-type": type } })).json()).file
      .id;
  const image = await upload("image/png");
  const text = await upload("text/plain");
  const signing = {
    ...env,
    NAP_R2_ACCOUNT_ID: "acct",
    NAP_R2_BUCKET: "nap-sites",
    NAP_R2_ACCESS_KEY_ID: "key",
    NAP_R2_SECRET_ACCESS_KEY: "secret",
  };
  const url = new URL(await runNap(signing, notificationImageUrl("quiz", image, null)));
  assert.equal(url.origin, "https://acct.r2.cloudflarestorage.com");
  assert.equal(url.pathname, `/nap-sites/files/quiz/${image}`);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "604800");
  assert.ok(url.searchParams.get("X-Amz-Signature"));
  // A local stage without R2 signing: the local dev URL.
  assert.equal(
    await runNap(env, notificationImageUrl("quiz", image, "http://localhost:1337")),
    `http://localhost:1337/s/quiz/_nap/files/${image}`,
  );
  assert.equal(await runNap(env, notificationImageUrl("quiz", image, null)), null);
  for (const id of [text, "b".repeat(24), "../x"]) {
    await assert.rejects(runNap(signing, notificationImageUrl("quiz", id, null)), (error) =>
      /image file of this site/.test(error.body?.error),
    );
  }
});

test("deleting a site's files removes only that site's", async () => {
  const { env, SITES } = setup();
  await client(env)("POST", "", { body: "x", headers: { "content-type": "text/plain" } });
  await SITES.put("files/quizzes/keep", "y");
  await SITES.put("sites/quiz/versions/v1/index.html", "z");
  assert.equal(await runNap(env, deleteSiteFiles("quiz")), 1);
  assert.deepEqual([...SITES.objects.keys()].sort(), [
    "files/quizzes/keep",
    "sites/quiz/versions/v1/index.html",
  ]);
});
