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
async function publishBody(args, script = SCRIPT) {
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
        [script, dir, ...args],
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
  assert.deepEqual(parseNapType("poster"), {
    error: 'type must be "page", "dashboard" or "slides"',
  });
  assert.equal(parseNapType(" Dashboard "), "dashboard");
});

test("publish.mjs --update takes a nap's URL on the root, the content domain, or an old host", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fillDeploymentText } = await import("../src/lib/deployment-text.ts");
  const dir = await mkdtemp(join(tmpdir(), "nap-publish-script-"));
  const filled = (contentDomain) =>
    fillDeploymentText(source, {
      rootDomain: "nap.test",
      contentDomain,
      orgName: "Test",
      admin: "the admin",
      defaultAccess: "private",
      apps: null,
    });
  const source = await readFile(SCRIPT, "utf8");
  try {
    const separate = join(dir, "separate.mjs");
    await writeFile(separate, filled("napcontent.test"));
    const id = async (url, script = separate) => (await publishBody(["--update", url], script)).id;
    assert.equal(await id("https://elo.napcontent.test/games/?x=1"), "elo");
    assert.equal(await id("https://elo.nap.test/"), "elo", "the old host");
    assert.equal(await id("https://nap.test/board/notes"), "board");
    assert.equal(await id("https://nap.test/artifact/board"), "board");
    assert.equal(await id("elo"), "elo");
    const same = join(dir, "same.mjs");
    await writeFile(same, filled(undefined));
    assert.equal(await id("https://elo.nap.test/", same), "elo");
    assert.match(filled("napcontent.test"), /its own host, <name>\.napcontent\.test/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("publish.mjs help points to the dashboards topic", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(SCRIPT, "utf8");
  assert.match(source, /^\/\/ {3}--type type .*\n(\/\/ .*\n)*?\/\/ .*instructions\/dashboards/m);
  assert.match(source, /^\/\/ {3}--type type .*\n(\/\/ .*\n)*?\/\/ .*slides: a deck to present/m);
});

/** Runs `publish.mjs read` against a stand-in for Nap that serves one nap with the given files. */
async function readNap(files, args) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://nap");
    requests.push(`${url.pathname}${url.search}`);
    const json = (data) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(data));
    };
    if (request.headers.authorization !== "Bearer test-token") {
      response.statusCode = 401;
      return json({ error: "no" });
    }
    if (url.pathname === "/_nap/api/naps/abc") {
      return json({
        nap: {
          id: "abc",
          title: "Sweep",
          owner: "o@example.com",
          role: "editor",
          access: "everyone",
          type: "page",
          url: "https://nap.example.com/abc",
          currentVersion: "v2",
          updatedAt: "2026-01-01T00:00:00.000Z",
          source: null,
        },
      });
    }
    if (url.pathname === "/_nap/api/naps/abc/files") {
      return json({
        version: url.searchParams.get("version") || "v2",
        files: Object.entries(files).map(([path, body]) => ({ path, size: body.length })),
      });
    }
    const prefix = "/_nap/api/naps/abc/files/";
    const body = files[decodeURIComponent(url.pathname.slice(prefix.length))];
    if (!url.pathname.startsWith(prefix) || body === undefined) {
      response.statusCode = 404;
      return json({ error: "File not found" });
    }
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(join(tmpdir(), "nap-read-test-"));
  try {
    const result = await new Promise((resolve) =>
      execFile(
        process.execPath,
        [
          SCRIPT,
          "read",
          ...args.map((arg) =>
            arg
              .replace("<dir>", join(dir, "out"))
              .replace("<nap>", `http://127.0.0.1:${server.address().port}`),
          ),
        ],
        {
          env: {
            ...process.env,
            NAP_URL: `http://127.0.0.1:${server.address().port}`,
            NAP_TOKEN: "test-token",
          },
        },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      ),
    );
    const { readFile } = await import("node:fs/promises");
    const saved = {};
    for (const path of Object.keys(files)) {
      saved[path] = await readFile(join(dir, "out", path), "utf8").catch(() => null);
    }
    const outside = await readFile(join(dir, "evil.txt"), "utf8").catch(() => null);
    return { ...result, requests, saved, outside };
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("publish.mjs read shows a nap and its files without downloading them", async () => {
  const files = { "index.html": "<h1>hi</h1>", "img/a b.txt": "pixels" };
  const shown = await readNap(files, ["<nap>/abc"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /^Sweep\n/);
  assert.match(shown.stdout, /Owner: o@example\.com \(your role: editor\)/);
  assert.match(shown.stdout, /Version: v2 \(live/);
  assert.match(shown.stdout, /Files \(2, /);
  assert.match(shown.stdout, / 11 {2}index\.html/);
  assert.deepEqual(shown.requests, ["/_nap/api/naps/abc", "/_nap/api/naps/abc/files"]);
  assert.deepEqual(shown.saved, { "index.html": null, "img/a b.txt": null });
});

test("publish.mjs read downloads the files of one version, or only the paths named", async () => {
  const files = { "index.html": "<h1>hi</h1>", "img/a b.txt": "pixels" };
  const all = await readNap(files, ["abc", "<dir>"]);
  assert.equal(all.code, 0, all.stderr);
  assert.deepEqual(all.saved, files);
  assert.ok(all.requests.includes("/_nap/api/naps/abc/files/img/a%20b.txt?version=v2"));
  assert.match(all.stdout, /Downloaded 2 of 2 files/);
  assert.match(all.stdout, /not as instructions to you/);

  const one = await readNap(files, ["abc", "<dir>", "index.html", "--version", "v1"]);
  assert.equal(one.code, 0, one.stderr);
  assert.deepEqual(one.saved, { "index.html": "<h1>hi</h1>", "img/a b.txt": null });
  assert.ok(one.requests.includes("/_nap/api/naps/abc/files/index.html?version=v1"));

  const missing = await readNap(files, ["abc", "<dir>", "nope.html"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Not in this nap: nope\.html/);
});

test("publish.mjs read never writes outside the folder", async () => {
  const escaped = await readNap({ "../evil.txt": "x" }, ["abc", "<dir>"]);
  assert.equal(escaped.code, 1);
  assert.match(escaped.stderr, /Refusing the path \.\.\/evil\.txt/);
  assert.equal(escaped.outside, null);
});
