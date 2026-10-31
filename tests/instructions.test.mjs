import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { OPTIONAL_TOPICS, renderInstructions } from "../src/lib/instructions-text.ts";

const dir = new URL("../src/content/instructions/", import.meta.url);
const read = (name) => readFileSync(new URL(`${name}.md`, dir), "utf8");
const files = readdirSync(dir).map((file) => file.replace(/\.md$/, ""));
const loader = readFileSync(new URL("../src/lib/agent-instructions.ts", import.meta.url), "utf8");

const config = (overrides = {}) => ({
  rootDomain: "nap.example.com",
  orgName: "Example",
  defaultAccess: "private",
  admin: "the admin",
  apps: { teamId: "T", bundleIdPrefix: "com.example", profileName: "P" },
  ...overrides,
});
const indexTopics = (text) => [...text.matchAll(/^- `([a-z]+)`:/gm)].map((match) => match[1]);

test("every topic the index lists has a file and is served", () => {
  const listed = indexTopics(renderInstructions(read("index"), config()));
  assert.ok(listed.length >= 7, "the index lists its topics");
  for (const topic of listed) {
    assert.ok(files.includes(topic), `${topic}.md exists`);
    assert.match(loader, new RegExp(`^  ${topic},$`, "m"), `agent-instructions.ts serves ${topic}`);
  }
  for (const file of files) {
    if (file !== "index") assert.ok(listed.includes(file), `the index lists ${file}`);
  }
});

test("without apps, the index leaves out the apps topic", () => {
  const listed = indexTopics(renderInstructions(read("index"), config({ apps: null })));
  assert.ok(!listed.includes("apps"));
  assert.equal(OPTIONAL_TOPICS.apps(config({ apps: null })), false);
  assert.equal(OPTIONAL_TOPICS.apps(config()), true);
});

test("the default access decides what the index says about sharing", () => {
  const privately = renderInstructions(read("index"), config());
  assert.match(privately, /New pages are private/);
  assert.doesNotMatch(privately, /New pages are shared with everyone/);
  const openly = renderInstructions(read("index"), config({ defaultAccess: "everyone" }));
  assert.match(openly, /New pages are shared with everyone at Example/);
  assert.doesNotMatch(openly, /New pages are private/);
});

test("every page fills in the deployment and leaves no markers", () => {
  for (const file of files) {
    for (const defaultAccess of ["private", "everyone"]) {
      const text = renderInstructions(read(file), config({ defaultAccess }));
      assert.doesNotMatch(text, /\{\{\w+\}\}/, `${file}: placeholders filled`);
      assert.doesNotMatch(text, /<!--/, `${file}: no markers left`);
      assert.doesNotMatch(text, /\n\n\n/, `${file}: no empty runs of lines`);
    }
  }
});
