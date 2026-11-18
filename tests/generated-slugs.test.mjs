import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Effect } from "effect";

// uploads.ts uses the ~/ alias.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("~/")) {
      return next(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});
const uploads = await import("../src/lib/uploads.ts");
const { generatedSlug, isReservedSlug, titleSlug } = uploads;

// The pickers take an Effect predicate; these tests write plain async ones.
const lift = (isTaken) => (slug) => Effect.promise(() => isTaken(slug));
const pickGeneratedSlug = (title, isTaken) =>
  Effect.runPromise(uploads.pickGeneratedSlug(title, lift(isTaken)));
const pickArtifactId = (isTaken) => Effect.runPromise(uploads.pickArtifactId(lift(isTaken)));

test("title slugs are short, readable DNS labels", () => {
  assert.equal(titleSlug("Sleep report: Q3 (draft)"), "sleep-report-q3-draft");
  assert.equal(titleSlug("Café Übersicht"), "cafe-ubersicht");
  assert.equal(titleSlug("  --  "), "");
  assert.equal(titleSlug("Untitled artifact"), "");
  assert.equal(titleSlug("Untitled site"), "");
  assert.equal(titleSlug("Untitled nap"), "");
  assert.equal(titleSlug(undefined), "");
  assert.equal(
    titleSlug("A very long title about weekly sleep metrics"),
    "a-very-long-title-about",
  );
  assert.ok(titleSlug("x".repeat(80)).length <= 24);
});

test("generated slugs have a random suffix, or are a short id", () => {
  assert.match(generatedSlug("Q3 & more"), /^q3-more-[a-z0-9]{4}$/);
  assert.match(generatedSlug("Untitled artifact"), /^[a-z0-9]{6}$/);
  assert.match(generatedSlug(""), /^[a-z0-9]{6}$/);
  for (let i = 0; i < 200; i++) {
    const slug = generatedSlug("x".repeat(80));
    assert.ok(slug.length <= 32 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug));
  }
  assert.ok(!isReservedSlug(generatedSlug("api")), "a suffix keeps it off reserved names");
});

test("the plain title comes first; a suffix only on conflict", async () => {
  const free = async () => false;
  assert.equal(await pickGeneratedSlug("Q3 report", free), "q3-report");
  const taken = async (slug) => slug === "q3-report";
  assert.match(await pickGeneratedSlug("Q3 report", taken), /^q3-report-[a-z0-9]{4}$/);
  assert.match(await pickGeneratedSlug("API", free), /^api-[a-z0-9]{4}$/, "reserved");
  assert.match(await pickGeneratedSlug("", free), /^[a-z0-9]{6}$/);
});

test("artifact ids are random, not made from the title", async () => {
  const free = async () => false;
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(await pickArtifactId(free));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[a-z0-9]{12}$/);
  let calls = 0;
  const takenOnce = async () => calls++ === 0;
  assert.match(await pickArtifactId(takenOnce), /^[a-z0-9]{12}$/);
  assert.equal(calls, 2, "a taken id is retried");
});

test("a new nap is in the frame by default, with a chosen name or a random id", () => {
  const { napShape } = uploads;
  const shape = (fields) =>
    napShape({ kind: "", ownHost: undefined, name: "", slug: "", ...fields });
  assert.deepEqual(shape({}), { kind: "artifact", slug: "" });
  assert.deepEqual(shape({ name: "elo" }), { kind: "artifact", slug: "elo" });
  assert.deepEqual(shape({ name: "elo", ownHost: "true" }), { kind: "site", slug: "elo" });
  assert.deepEqual(shape({ name: "elo", ownHost: true }), { kind: "site", slug: "elo" });
  assert.deepEqual(shape({ ownHost: "false" }), { kind: "artifact", slug: "" });
  assert.deepEqual(shape({ ownHost: "maybe" }), { error: "ownHost must be true or false" });
});

test("the older kind and slug fields mean what they always did", () => {
  const { napShape } = uploads;
  const shape = (fields) =>
    napShape({ kind: "", ownHost: undefined, name: "", slug: "", ...fields });
  assert.deepEqual(shape({ kind: "artifact" }), { kind: "artifact", slug: "" });
  assert.deepEqual(shape({ kind: "site" }), { kind: "site", slug: "" });
  // A slug alone has always meant its own host.
  assert.deepEqual(shape({ slug: "map" }), { kind: "site", slug: "map" });
  assert.deepEqual(shape({ kind: "site", slug: "map" }), { kind: "site", slug: "map" });
  // Which used to be refused, and is a chosen name in the frame now.
  assert.deepEqual(shape({ kind: "artifact", slug: "map" }), { kind: "artifact", slug: "map" });
  assert.deepEqual(shape({ kind: "page" }), { error: 'kind must be "artifact" or "site"' });
  assert.ok("error" in shape({ kind: "site", ownHost: false }), "kind and ownHost must agree");
  assert.ok("error" in shape({ name: "a", slug: "b" }), "one name");
  assert.deepEqual(shape({ kind: "artifact", ownHost: "false" }), { kind: "artifact", slug: "" });
});
