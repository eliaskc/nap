import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const { handleExtensionRequest, clientTypesWithExtensions } = await import(
  "../src/lib/extensions.ts"
);
const { respond } = await import("../src/server/runtime.ts");
const { findExtensions, clientModuleSource, serverModuleSource } = await import(
  "../scripts/lib/extensions.ts"
);
const { renderInstructions } = await import("../src/lib/instructions-text.ts");
const { parseExtensionSecrets } = await import("../src/server/platform.ts");
const { bundleClient } = await import("../scripts/lib/client-bundle.ts");

const OWNER = "owner@example.com";
const STRANGER = "stranger@example.com";

function environment(secrets = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO profiles (email) VALUES ('${OWNER}');
    INSERT INTO sites (slug, title, created_by_email, updated_by_email, current_version, sort_order,
      visibility, kind)
      VALUES ('board', 'Board', '${OWNER}', '${OWNER}', 'v1', 1, 'private', 'site'),
             ('chart', 'Chart', '${OWNER}', '${OWNER}', 'v1', 2, 'private', 'artifact');`);
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
  const objects = new Map();
  const SITES = {
    async get(key) {
      const stored = objects.get(key);
      return stored ? { text: async () => stored.value, uploaded: stored.uploaded } : null;
    },
    async put(key, value) {
      objects.set(key, { value, uploaded: new Date() });
      return {};
    },
  };
  return { DB, SITES, objects, NAP_EXTENSION_SECRETS: JSON.stringify(secrets) };
}


/** An extension that echoes what Nap gave it. */
const echo = {
  name: "echo",
  types: null,
  instructions: null,
  server: {
    summary: "Echoes",
    secrets: ["ECHO_KEY"],
    async handle(request, context) {
      let done = false;
      context.waitUntil(new Promise((resolve) => setTimeout(resolve, 5)).then(() => (done = true)));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const before = await context.cache.get("k");
      await context.cache.put("k", "v");
      const after = await context.cache.get("k");
      return Response.json({
        method: request.method,
        path: context.path,
        page: context.page,
        viewer: context.viewer.email,
        secrets: context.secrets,
        backgroundDone: done,
        cache: [before, after?.value, after?.storedAt instanceof Date],
      });
    },
  },
};
const broken = {
  name: "broken",
  types: null,
  instructions: null,
  server: {
    summary: "Throws",
    async handle() {
      throw new Error("boom");
    },
  },
};

function call(env, slug, path, { email = OWNER, frame = false, headers = {} } = {}) {
  const request = new Request(`https://${slug}.nap.test/_nap/ext/${path}`, { headers });
  return respond(
    env,
    handleExtensionRequest(
      [echo, broken],
      slug,
      request,
      { email, name: email },
      path,
      { frame },
    ),
  );
}

test("an extension gets the path, the page, the viewer, and only its own secrets", async () => {
  const env = environment({ ECHO_KEY: "k", OTHER_KEY: "never" });
  const response = await call(env, "board", "echo/charts/a");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.path, "charts/a");
  assert.deepEqual(body.page, { slug: "board", kind: "site" });
  assert.equal(body.viewer, OWNER);
  assert.deepEqual(body.secrets, { ECHO_KEY: "k" });
  assert.equal(body.backgroundDone, true);
  assert.deepEqual(body.cache, [null, "v", true]);
  assert.match([...env.objects.keys()][0], /^extension-cache\/echo\/[0-9a-f]{64}$/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("only people who can view the page, and no cross-site calls on sites", async () => {
  const env = environment();
  assert.equal((await call(env, "board", "echo/x", { email: STRANGER })).status, 403);
  assert.equal(
    (await call(env, "board", "echo/x", { headers: { "sec-fetch-site": "cross-site" } })).status,
    403,
  );
  assert.equal((await call(env, "missing", "echo/x")).status, 404);
  const unknown = await call(env, "board", "nope/x");
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).error, /nap\.nope is not on this Nap/);
});

test("artifact frames are cross-site by nature and reach only artifacts", async () => {
  const env = environment();
  const framed = await call(env, "chart", "echo/x", {
    frame: true,
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(framed.status, 200);
  assert.deepEqual((await framed.json()).page, { slug: "chart", kind: "artifact" });
  assert.equal((await call(env, "board", "echo/x", { frame: true })).status, 404);
});

test("a throwing extension is a 500 that names it", async () => {
  const response = await call(environment(), "board", "broken/x");
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "nap.broken failed" });
});

test("secrets are a JSON object of strings, and anything else is none", () => {
  assert.deepEqual(parseExtensionSecrets('{"A":"1","B":2}'), { A: "1" });
  assert.deepEqual(parseExtensionSecrets("[1]"), {});
  assert.deepEqual(parseExtensionSecrets("{"), {});
  assert.deepEqual(parseExtensionSecrets(""), {});
});

function instance(files) {
  const root = mkdtempSync(join(tmpdir(), "nap-extensions-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("extensions come from instance/extensions, with checked names", () => {
  assert.deepEqual(findExtensions(instance({})), []);
  const root = instance({
    "instance/extensions/demo/server.ts": "export default {};",
    "instance/extensions/demo/client.ts": "export default () => ({});",
    "instance/extensions/demo/instructions.md": "# Demo\n",
  });
  const [demo] = findExtensions(root);
  assert.equal(demo.name, "demo");
  assert.ok(demo.client && demo.instructions && !demo.types);
  assert.match(serverModuleSource([demo]), /instructions: "# Demo\\n"/);
  assert.match(clientModuleSource([demo]), /\["demo", client0\]/);

  const named = (name) => () =>
    findExtensions(instance({ [`instance/extensions/${name}/server.ts`]: "export default {};" }));
  assert.throws(named("Bad-Name"), /lowercase letters and digits/);
  assert.throws(named("fetch"), /Nap's own/);
  assert.throws(
    () => findExtensions(instance({ "instance/extensions/empty/client.ts": "" })),
    /no server\.ts/,
  );
});

test("extension types follow Nap's, and topics join the index", () => {
  const types = clientTypesWithExtensions("base\n", [
    { ...echo, types: "export interface Nap { echo: { ping(): void } }" },
  ]);
  assert.match(types, /^base\n\n\/\/ nap\.echo\n\nexport interface Nap/);

  const config = { rootDomain: "nap.example.com", orgName: "E", defaultAccess: "private", admin: "A", apps: null };
  const index = readFileSync("src/content/instructions/index.md", "utf8");
  const plain = renderInstructions(index, config);
  assert.doesNotMatch(plain, /extensionTopics/);
  const withEcho = renderInstructions(index, config, undefined, [{ name: "echo", summary: "Echoes" }]);
  assert.match(withEcho, /^- `echo`: Echoes \(`nap\.echo`\)\.$/m);
});

test("client.js mounts each extension's client as nap.<name>, with a kit for its endpoints", async () => {
  const root = instance({
    "instance/extensions/demo/server.ts": "export default {};",
    "instance/extensions/demo/client.ts": `export default (kit) => ({
      hello: (name) => kit.json("hello/" + name),
      Error: kit.NapError,
    });`,
  });
  const { client } = await bundleClient({ root });
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    return url.includes("missing")
      ? Response.json({ error: "No such thing" }, { status: 404 })
      : Response.json({ ok: true });
  };
  const run = (href) => {
    const window = {};
    const document = { hidden: false, currentScript: { src: "" }, addEventListener() {} };
    new Function("window", "document", "location", "fetch", "addEventListener", client)(
      window,
      document,
      new URL(href),
      fetch,
      () => {},
    );
    return window.nap;
  };
  const nap = run("https://board.nap.test/");
  assert.deepEqual(await nap.demo.hello("you"), { ok: true });
  assert.equal(requests.at(-1), "/_nap/ext/demo/hello/you");
  await assert.rejects(nap.demo.hello("missing"), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.message, "No such thing");
    return error instanceof nap.demo.Error;
  });
  assert.equal(typeof nap.db.collection, "function", "Nap's own names stay");

  run("https://nap.test/_nap/frame/abc123/").demo.hello("x");
  assert.equal(requests.at(-1), "/_nap/frame/abc123/_nap/ext/demo/hello/x");
});
