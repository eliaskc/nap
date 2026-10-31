import test from "node:test";
import assert from "node:assert/strict";
import {
  generatedSlug,
  isReservedSlug,
  pickArtifactId,
  pickGeneratedSlug,
  titleSlug,
} from "../src/lib/uploads.ts";

test("title slugs are short, readable DNS labels", () => {
  assert.equal(titleSlug("Sleep report: Q3 (draft)"), "sleep-report-q3-draft");
  assert.equal(titleSlug("Café Übersicht"), "cafe-ubersicht");
  assert.equal(titleSlug("  --  "), "");
  assert.equal(titleSlug("Untitled artifact"), "");
  assert.equal(titleSlug("Untitled site"), "");
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
