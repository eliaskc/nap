import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export const env = {}", shortCircuit: true };
    }
    if (specifier.startsWith("~/")) {
      return next(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});
const { parseManifest } = await import("../src/lib/site-manifest.ts");

test("nap.json: spa only when true, and only valid fetch hosts", () => {
  const none = { allow: {} };
  assert.deepEqual(parseManifest(null), { fetch: [], spa: false, data: none });
  assert.deepEqual(parseManifest({ spa: "yes" }), { fetch: [], spa: false, data: none });
  assert.deepEqual(
    parseManifest({ spa: true, fetch: [" API.example.com ", "*.x.org", "bad", 3] }),
    {
      fetch: ["api.example.com", "*.x.org"],
      spa: true,
      data: none,
    },
  );
  assert.equal(
    parseManifest({ fetch: Array.from({ length: 30 }, (_, i) => `h${i}.com`) }).fetch.length,
    20,
  );
});

test("nap.json: data.allow keeps only valid sites and collections", () => {
  const manifest = parseManifest({
    data: { allow: { weave: ["weave", "weave", "Bad", 3], "Bad slug": ["x"], empty: [] } },
  });
  assert.deepEqual(manifest.data, { allow: { weave: ["weave"] } });
  assert.deepEqual(parseManifest({ data: { allow: ["weave"] } }).data, { allow: {} });
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}`, ["c"]]));
  assert.equal(Object.keys(parseManifest({ data: { allow: many } }).data.allow).length, 20);
});
