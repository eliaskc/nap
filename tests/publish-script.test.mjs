import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";

// uploads.ts uses the ~/ alias.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("~/")) {
      return next(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});
const { napShape } = await import("../src/lib/uploads.ts");

const SCRIPT = new URL("../src/content/publish.mjs", import.meta.url).pathname;

/**
 * Runs publish.mjs against a stand-in for Nap's upload API, with an empty file list so nothing
 * is PUT, and returns what it asked Nap to make.
 */
async function publishBody(args) {
  const bodies = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const origin = `http://127.0.0.1:${server.address().port}`;
    response.setHeader("content-type", "application/json");
    if (request.url === "/_nap/api/uploads") {
      const body = JSON.parse(text);
      bodies.push(body);
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          uploadId: "u",
          id: body.name || "random",
          files: [],
          nextPage: null,
          commitUrl: `${origin}/_nap/api/uploads/u/commit`,
        }),
      );
      return;
    }
    response.end(JSON.stringify({ created: true, access: "private", id: "x", url: `${origin}/x` }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(join(tmpdir(), "nap-publish-test-"));
  try {
    await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
    await new Promise((resolve, reject) =>
      execFile(
        process.execPath,
        [SCRIPT, dir, ...args],
        {
          env: {
            ...process.env,
            NAP_URL: `http://127.0.0.1:${server.address().port}`,
            NAP_TOKEN: "test-token",
          },
        },
        (error, stdout, stderr) => (error ? reject(new Error(stderr || stdout)) : resolve()),
      ),
    );
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(bodies.length, 1);
  return bodies[0];
}

/** How Nap reads the body (agent-api.ts passes these fields to napShape). */
const served = (body) =>
  napShape({
    kind: body.kind ?? "",
    ownHost: body.ownHost,
    name: body.name ?? "",
    slug: body.slug ?? "",
  });

test("publish.mjs makes a nap in the frame by default, with a name if given", async () => {
  assert.deepEqual(served(await publishBody([])), { kind: "artifact", slug: "" });
  assert.deepEqual(served(await publishBody(["--name", "elo"])), { kind: "artifact", slug: "elo" });
});

test("publish.mjs puts a nap on its own host with --own-host, and --site and --slug still do", async () => {
  const own = { kind: "site", slug: "elo" };
  assert.deepEqual(served(await publishBody(["--name", "elo", "--own-host"])), own);
  assert.deepEqual(served(await publishBody(["--slug", "elo"])), own, "--slug as before");
  assert.deepEqual(served(await publishBody(["--site"])), { kind: "site", slug: "" });
});

test("what older copies of publish.mjs send means the same as before", () => {
  // Older copies sent kind "site" with --site or --slug, and nothing else for an artifact.
  assert.deepEqual(served({}), { kind: "artifact", slug: "" });
  assert.deepEqual(served({ kind: "site" }), { kind: "site", slug: "" });
  assert.deepEqual(served({ kind: "site", slug: "elo" }), { kind: "site", slug: "elo" });
});

test("publish.mjs sends --type, and nothing without it, so Nap keeps its default", async () => {
  const { parseNapType } = await import("../src/lib/nap-types.ts");
  const dashboard = await publishBody(["--type", "dashboard"]);
  assert.equal(dashboard.type, "dashboard");
  assert.equal(parseNapType(dashboard.type), "dashboard");
  const plain = await publishBody([]);
  assert.equal(plain.type, undefined, "no --type, no type");
  assert.equal(parseNapType(plain.type), undefined, "Nap makes it a page");
  const update = await publishBody(["--update", "abc", "--type", "dashboard"]);
  assert.equal(update.id, "abc");
  assert.equal(update.type, "dashboard", "an update can change it");
  assert.deepEqual(parseNapType("slides"), { error: 'type must be "page" or "dashboard"' });
  assert.equal(parseNapType(" Dashboard "), "dashboard");
});

test("publish.mjs help points to the dashboards topic", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(SCRIPT, "utf8");
  assert.match(source, /^\/\/ {3}--type type .*\n(\/\/ .*\n)*?\/\/ .*instructions\/dashboards/m);
});
