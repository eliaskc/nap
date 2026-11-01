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
  assert.deepEqual(parseManifest(null), { fetch: [], spa: false });
  assert.deepEqual(parseManifest({ spa: "yes" }), { fetch: [], spa: false });
  assert.deepEqual(
    parseManifest({ spa: true, fetch: [" API.example.com ", "*.x.org", "bad", 3] }),
    {
      fetch: ["api.example.com", "*.x.org"],
      spa: true,
    },
  );
  assert.equal(
    parseManifest({ fetch: Array.from({ length: 30 }, (_, i) => `h${i}.com`) }).fetch.length,
    20,
  );
});
