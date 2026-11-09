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
  apps: {
    app: "nap",
    ios: { teamId: "T", appStoreId: "1", bundleId: "com.example.nap", profileName: "S" },
  },
  notifications: true,
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

test("notifications are a topic only on Naps that have them", () => {
  const listed = indexTopics(
    renderInstructions(read("index"), config({ notifications: undefined })),
  );
  assert.ok(!listed.includes("notifications"));
  assert.equal(OPTIONAL_TOPICS.notifications(config({ notifications: undefined })), false);
  assert.equal(OPTIONAL_TOPICS.notifications(config()), true);
});

test("channel servers show in the index and the channels topic only where they are on", () => {
  const off = config();
  const on = config({ channelServers: true });
  assert.match(renderInstructions(read("index"), off), /There is no server code/);
  assert.doesNotMatch(renderInstructions(read("index"), off), /channel's own server/);
  assert.doesNotMatch(renderInstructions(read("index"), on), /There is no server code/);
  assert.match(renderInstructions(read("index"), on), /channel's own server/);
  assert.doesNotMatch(renderInstructions(read("channels"), off), /Channel servers/);
  assert.match(renderInstructions(read("channels"), on), /## Channel servers/);
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

test("the apps topic names the one app, and iOS goes to TestFlight", () => {
  const text = renderInstructions(read("apps"), config());
  assert.match(text, /one app on Nap, `nap`/);
  assert.match(text, /ios\/scripts\/publish/);
  assert.match(text, /app clone nap/);
  assert.doesNotMatch(text, /\{\{/);
  assert.doesNotMatch(text, /ad hoc|standalone|prototype/i);
});

test("reMarkable shows in the apps topic only when the Nap has it", () => {
  const off = renderInstructions(read("apps"), config());
  assert.doesNotMatch(off, /remarkable/i);
  const on = renderInstructions(read("apps"), config({ apps: { app: "nap", remarkable: {} } }));
  assert.match(on, /remarkable\/scripts\/publish/);
  assert.match(on, /targets\/remarkable/);
  assert.doesNotMatch(on, /ios\/scripts\/publish/);
  assert.doesNotMatch(on, /<!--|\{\{/);
});

test("looks show in the instructions only when the Nap has avatars", () => {
  const off = renderInstructions(read("sites"), config());
  assert.doesNotMatch(off, /nap-avatar|nap\.looks|shape, color/);
  assert.match(off, /no avatars/);
  assert.doesNotMatch(renderInstructions(read("channels"), config()), /their look/);
  assert.match(renderInstructions(read("channels"), config({ avatars: true })), /their look/);
  const on = renderInstructions(read("sites"), config({ avatars: true }));
  assert.match(on, /nap-avatar/);
  assert.match(on, /nap\.looks/);
});
