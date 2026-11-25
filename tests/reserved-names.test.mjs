import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { Effect } from "effect";

registerHooks({
  resolve(specifier, context, next) {
    const stub = {
      "cloudflare:workers": "export const env = {}; export class DurableObject {}",
      "virtual:nap-comments-frame": "export default '';",
      "virtual:nap-client":
        "export const client = ''; export const voice = ''; export const voiceVersion = '';",
      "virtual:nap-extensions": "export const extensions = [];",
      "virtual:nap-instance-content": "export const kitFiles = []; export const instructions = {};",
    }[specifier];
    if (stub !== undefined) {
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
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
const uploads = await import("../src/lib/uploads.ts");
const { RESERVED_SLUGS, isReservedSlug } = uploads;
const { artifactRoute, legacyArtifactRoute, legacyArtifactRedirect } =
  await import("../src/lib/artifact-routes.ts");
const { artifactPath, napLabel, napUrl } = await import("../src/lib/nap-urls.ts");

/** What an artifact id or site slug can look like: the first path segment it would take. */
const NAME = /^[a-z0-9-]{1,32}$/;
const root = (path) => new URL(`../${path}`, import.meta.url);

function assertReserved(segments, where) {
  for (const segment of segments) {
    if (!NAME.test(segment)) continue;
    assert.ok(
      isReservedSlug(segment),
      `/${segment} (${where}) is a top-level route: add "${segment}" to RESERVED_SLUGS in src/lib/uploads.ts`,
    );
  }
}

test("every top-level route in src/routes is reserved", () => {
  const segments = new Set();
  for (const entry of readdirSync(root("src/routes"))) {
    if (statSync(root(`src/routes/${entry}`)).isDirectory()) {
      segments.add(entry);
      continue;
    }
    // TanStack flat routes: claim.$id.tsx is /claim/$id, index.tsx is /, __root.tsx is the layout.
    const first = entry.replace(/\.[jt]sx?$/, "").split(".")[0];
    if (first === "index" || first.startsWith("__") || first.startsWith("$")) continue;
    segments.add(first.replace(/^_/, "").replace(/_$/, ""));
  }
  assert.ok(segments.size >= 8, "found the routes");
  assertReserved(segments, "src/routes");
  // A route whose first segment is a parameter would catch every artifact.
  for (const entry of readdirSync(root("src/routes"))) {
    assert.ok(!entry.startsWith("$"), `src/routes/${entry} would take every top-level name`);
  }
});

test("every path the Worker answers on the root domain is reserved", () => {
  const source = readFileSync(root("src/worker.ts"), "utf8");
  const segments = new Set();
  // String paths ("/_nap/api", `/s/...`) and regex paths (/^\/s\/...).
  for (const match of source.matchAll(/["'`]\/([^/"'`?$\s]+)/g)) segments.add(match[1]);
  for (const match of source.matchAll(/\^\\\/([a-z0-9_-]+)\\\//g)) segments.add(match[1]);
  assert.ok(segments.has("_nap") && segments.has("s") && segments.has("api"), "found the paths");
  assertReserved(segments, "src/worker.ts");
});

test("every static file and built asset folder is reserved", () => {
  assertReserved(readdirSync(root("public")), "public/");
  // Vite writes the dashboard's JavaScript and CSS to /assets, and the comments UI to /_nap.
  assert.ok(isReservedSlug("assets"));
  assert.ok(isReservedSlug("_nap"));
  if (existsSync(root("dist/client")))
    assertReserved(readdirSync(root("dist/client")), "dist/client");
});

test("the names the redesign keeps for itself are reserved", () => {
  for (const name of ["artifact", "artifacts", "nap", "api", "app", "apps", "claim", "connect"]) {
    assert.ok(isReservedSlug(name), name);
  }
  for (const name of ["install", "requests", "s", "welcome", "_nap", "cdn-cgi"]) {
    assert.ok(isReservedSlug(name), name);
  }
  assert.ok(!isReservedSlug("weave"));
});

/** Makes crypto.getRandomValues give these strings first ([a-z0-9]), then real random bytes. */
async function withRandom(strings, run) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const original = crypto.getRandomValues.bind(crypto);
  const queue = [...strings];
  crypto.getRandomValues = (array) => {
    const next = queue.shift();
    if (next === undefined || next.length !== array.length) return original(array);
    for (let i = 0; i < next.length; i++) array[i] = alphabet.indexOf(next[i]);
    return array;
  };
  try {
    return await run();
  } finally {
    crypto.getRandomValues = original;
  }
}

test("random ids and slugs are never a reserved name", async () => {
  const free = () => Effect.succeed(false);
  // No reserved name is 12 characters long today; add one for the test.
  const fake = "aaaaaaaaaaaa";
  RESERVED_SLUGS.add(fake);
  try {
    const id = await withRandom([fake, fake, fake, fake, fake, fake, fake], () =>
      Effect.runPromise(uploads.pickArtifactId(free)),
    );
    assert.notEqual(id, fake);
    assert.match(id, /^[a-z0-9]{12}$/);
  } finally {
    RESERVED_SLUGS.delete(fake);
  }
  // Without a title, a generated slug is 6 random characters, the length of "assets".
  const slug = await withRandom(Array(8).fill("assets"), () =>
    Effect.runPromise(uploads.pickGeneratedSlug("", free)),
  );
  assert.notEqual(slug, "assets");
  assert.match(slug, /^[a-z0-9]{6}$/);
});

test("artifacts are at <root>/<id>", () => {
  const nap = { slug: "k3j9x0abcd12", kind: "artifact" };
  assert.equal(artifactPath("k3j9x0abcd12"), "/k3j9x0abcd12");
  assert.equal(
    napUrl(nap, { rootDomain: "nap.example.com" }),
    "https://nap.example.com/k3j9x0abcd12",
  );
  assert.equal(
    napUrl(nap, { rootDomain: "nap.example.com", localOrigin: "http://localhost:1337" }),
    "http://localhost:1337/k3j9x0abcd12",
  );
  assert.equal(napLabel(nap, "nap.example.com"), "nap.example.com/k3j9x0abcd12");
  assert.equal(
    napUrl({ slug: "elo", kind: "site" }, { rootDomain: "nap.example.com" }),
    "https://elo.nap.example.com/",
  );
});

test("Nap's own routes win over artifact names", () => {
  assert.deepEqual(artifactRoute("/k3j9x0abcd12"), {
    slug: "k3j9x0abcd12",
    rest: "",
    base: "/k3j9x0abcd12",
  });
  assert.deepEqual(artifactRoute("/k3j9x0abcd12/notes/a.html"), {
    slug: "k3j9x0abcd12",
    rest: "/notes/a.html",
    base: "/k3j9x0abcd12",
  });
  assert.equal(artifactRoute("/k3j9x0abcd12/_nap/comments").rest, "/_nap/comments");
  for (const path of [
    "/",
    "/api/sites",
    "/connect",
    "/claim/abc",
    "/s/elo/",
    "/_nap/frame/x",
    "/assets/main.js",
    "/favicon.ico",
    "/welcome",
    "/artifact/k3j9x0abcd12",
    "/cdn-cgi/access/logout",
    "/Upper",
    `/${"x".repeat(33)}`,
  ]) {
    assert.equal(artifactRoute(path), null, path);
  }
});

test("old /artifact/<id> links redirect permanently to /<id>", () => {
  assert.deepEqual(legacyArtifactRoute("/artifact/k3j9x0abcd12/notes/"), {
    slug: "k3j9x0abcd12",
    rest: "/notes/",
    base: "/artifact/k3j9x0abcd12",
  });
  assert.equal(legacyArtifactRoute("/artifact"), null);
  assert.equal(legacyArtifactRoute("/artifact/"), null);
  assert.equal(legacyArtifactRoute("/artifacts/x"), null);

  const at = (path, method = "GET") => {
    const request = new Request(`https://nap.example.com${path}`, { method });
    return legacyArtifactRedirect(request, legacyArtifactRoute(new URL(request.url).pathname));
  };
  const page = at("/artifact/k3j9x0abcd12");
  assert.equal(page.status, 301);
  assert.equal(page.headers.get("location"), "/k3j9x0abcd12");
  const deep = at("/artifact/k3j9x0abcd12/notes/a.html?x=1&y=2");
  assert.equal(deep.headers.get("location"), "/k3j9x0abcd12/notes/a.html?x=1&y=2");
  assert.equal(at("/artifact/k3j9x0abcd12", "HEAD").status, 301);
  const renew = at("/artifact/k3j9x0abcd12/_nap/frame", "POST");
  assert.equal(renew.status, 308, "keeps the method and body");
  assert.equal(renew.headers.get("location"), "/k3j9x0abcd12/_nap/frame");
});
