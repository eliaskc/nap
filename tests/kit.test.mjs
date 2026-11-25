import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceContentModuleSource, instanceInstructions, kitFiles } from "../scripts/lib/kit.ts";
import { withInstanceText } from "../scripts/lib/instance-text.ts";

function project(files) {
  const root = mkdtempSync(join(tmpdir(), "nap-kit-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
const byPath = (files) => Object.fromEntries(files.map((file) => [file.path, file]));

test("the kit is kit/ without what installing and building leave behind", () => {
  const root = project({
    "kit/KIT.md": "# Kit\n",
    "kit/gitignore": "dist\n",
    "kit/src/App.tsx": "export default 1\n",
    "kit/node_modules/x/index.js": "",
    "kit/dist/index.html": "",
  });
  const files = byPath(kitFiles(root));
  assert.deepEqual(Object.keys(files).sort(), [".gitignore", "KIT.md", "src/App.tsx"]);
  assert.equal(files["KIT.md"].content, "# Kit\n");
  assert.equal(files["KIT.md"].encoding, "utf8");
});

test("an instance replaces and adds kit files, fonts as base64, and adds to KIT.md", () => {
  const root = project({
    "kit/KIT.md": "# Kit\n",
    "kit/theme.json": '{"default":"neutral"}',
    "kit/src/theme/instance.css": "/* empty */",
    "instance/kit/theme.json": '{"default":"plain"}',
    "instance/kit/src/theme/instance.css": ":root{}",
    "instance/kit/src/assets/fonts/a.woff2": Buffer.from([0, 1, 2, 255]),
    "instance/kit/src/kit/logo.tsx": "export const Logo = 1\n",
    "instance/instructions/kit.md": "Themes: plain.\n",
    "instance/instructions/design.md": "Write in English.\n",
  });
  const files = byPath(kitFiles(root));
  assert.equal(files["theme.json"].content, '{"default":"plain"}');
  assert.equal(files["src/theme/instance.css"].content, ":root{}");
  assert.equal(files["src/kit/logo.tsx"].content, "export const Logo = 1\n");
  assert.deepEqual(files["src/assets/fonts/a.woff2"], {
    path: "src/assets/fonts/a.woff2",
    content: Buffer.from([0, 1, 2, 255]).toString("base64"),
    encoding: "base64",
  });
  assert.equal(files["KIT.md"].content, "# Kit\n\n## On this Nap\n\nThemes: plain.\n");
  assert.deepEqual(Object.keys(instanceInstructions(root)).sort(), ["design", "kit"]);
  // kit.md is in KIT.md already, so it is not also added to the kit topic.
  const source = instanceContentModuleSource(root);
  assert.match(source, /export const instructions = \{"design":"Write in English\.\\n"\};/);
});

test("instance instructions are topics by name", () => {
  assert.deepEqual(instanceInstructions(project({})), {});
  assert.throws(
    () => instanceInstructions(project({ "instance/instructions/My Topic.md": "" })),
    /topics are <name>\.md/,
  );
  assert.equal(withInstanceText("# A\n", undefined), "# A\n");
  assert.equal(withInstanceText("# A\n", "  \n"), "# A\n");
});

test("Nap's own kit has a guide, a neutral theme, and no instance themes", () => {
  const root = new URL("..", import.meta.url).pathname;
  const read = (path) => readFileSync(join(root, "kit", path), "utf8");
  assert.match(read("KIT.md"), /^# Nap kit/);
  assert.deepEqual(JSON.parse(read("theme.json")), {
    default: "neutral",
    themes: [{ id: "neutral", label: "Neutral" }],
  });
  assert.doesNotMatch(read("src/theme/instance.css").replace(/\/\*[\s\S]*?\*\//g, ""), /\S/);
  assert.match(read("src/theme/tokens.css"), /--bg:/);
});
