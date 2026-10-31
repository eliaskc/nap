// End-to-end check of source repos against real Cloudflare Artifacts: Nap on a new local Alchemy
// stage (its own D1/R2) with its SOURCES binding pointed at a test namespace.
// It signs agents in, creates a repo, clones and pushes with plain git (and jj, if installed)
// through publish.mjs, and checks which commits Nap lets go live.
//
// Needs Cloudflare credentials with Artifacts access in the Alchemy profile NAP_ALCHEMY_PROFILE
// (default nap, from `pnpm infra:login`; a profile that reads the environment takes
// CLOUDFLARE_API_TOKEN), the cf CLI, and git. It creates repos in the namespace
// NAP_SOURCES_TEST_NAMESPACE (default nap-sites-test) and deletes them with the cf CLI at the end. It never touches the production namespace or production data.
import { spawnSync, execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startLocalNap } from "../lib/local-nap.mjs";

const PORT = 8796;
const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const NAMESPACE = process.env.NAP_SOURCES_TEST_NAMESPACE || "nap-sites-test";
if (NAMESPACE === "nap-sites") throw new Error("Never run this against the production namespace");

const state = await mkdtemp(join(tmpdir(), "nap-sources-test-"));
const work = join(state, "work");
await mkdir(work);

function send(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const length = body ? { "content-length": Buffer.byteLength(body) } : {};
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        path,
        method,
        headers: { host: "localhost", ...length, ...headers },
        agent: false,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode, text: data, json });
        });
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error(`Timeout: ${method} ${path}`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const postJson = (path, value, headers = {}) =>
  send(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });

async function signIn(email) {
  const start = await postJson("/_nap/api/auth/device", { client: "sources test" });
  assert.equal(start.status, 200, start.text);
  const approved = await postJson(
    `/api/connect/${start.json.user_code}`,
    { action: "approve" },
    { "x-nap-dev-email": email },
  );
  assert.equal(approved.status, 200, approved.text);
  const token = await postJson("/_nap/api/auth/token", { device_code: start.json.device_code });
  assert.equal(token.status, 200, token.text);
  return token.json.token;
}

/** Publishes index.html through the Worker, with optional fields. */
function publish(token, path, html, fields = {}) {
  const boundary = "nap-sources-test";
  const parts = Object.entries(fields).map(
    ([name, value]) =>
      `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  parts.push(
    `--${boundary}\r\ncontent-disposition: form-data; name="files"; filename="index.html"\r\ncontent-type: text/html\r\n\r\n${html}\r\n--${boundary}--\r\n`,
  );
  return send(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: parts.join(""),
  });
}

/** Runs the publish script as an agent with its own Nap token. */
function script(token, args, options = {}) {
  const result = spawnSync("node", [join(state, "publish.mjs"), ...args], {
    encoding: "utf8",
    cwd: options.cwd ?? work,
    env: {
      ...process.env,
      NAP_URL: `http://localhost:${PORT}`,
      NAP_TOKEN: token,
      GIT_AUTHOR_NAME: "Nap test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Nap test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (!options.allowFailure)
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Nap test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Nap test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();

let nap;
let repo;
try {
  nap = await startLocalNap({
    port: PORT,
    label: "sources",
    profile: process.env.NAP_ALCHEMY_PROFILE || "nap",
    vars: { NAP_SOURCES_NAMESPACE: NAMESPACE },
  });

  const owner = await signIn(OWNER);
  const other = await signIn(OTHER);
  const scriptSource = await send("/_nap/api/publish.mjs");
  assert.equal(scriptSource.status, 200);
  await writeFile(join(state, "publish.mjs"), scriptSource.text);

  // A site published the usual way, shared with everyone.
  const slug = `src-${Date.now().toString(36)}`;
  const created = await publish(owner, "/_nap/api/naps", "<title>Source test</title>v0", {
    slug,
    access: "everyone",
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.id, slug);

  // Only the owner adds a repo.
  assert.equal(
    (
      await send(`/_nap/api/naps/${slug}/source`, {
        method: "POST",
        headers: { authorization: `Bearer ${other}` },
      })
    ).status,
    403,
  );
  const made = script(owner, ["source", slug, "--create"]);
  assert.match(made.stdout, /Created the source repo/);
  const info = await send(`/_nap/api/naps/${slug}/source`, {
    headers: { authorization: `Bearer ${owner}` },
  });
  assert.equal(info.status, 200, info.text);
  repo = info.json.source.repo;
  assert.equal(info.json.source.head, null);

  // Push the first commit with plain git through `run`. No token touches the disk.
  const source = join(work, "source");
  await mkdir(source);
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "index.html"), "<title>Source test</title>v1");
  git(source, "add", ".");
  git(source, "commit", "-qm", "feat: first version");
  git(source, "remote", "add", "origin", info.json.source.remote);
  script(owner, ["run", slug, "--", "git", "push", "-q", "origin", "main"], { cwd: source });
  const v1 = git(source, "rev-parse", "HEAD");
  const gitConfig = await readFile(join(source, ".git", "config"), "utf8");
  assert.doesNotMatch(gitConfig, /art_v|Bearer/, "no token in git config");

  // Publishing needs the commit, and the commit must be the head.
  let result = await publish(owner, `/_nap/api/naps/${slug}/versions`, "v1");
  assert.equal(result.status, 409);
  assert.equal(result.json.code, "source_commit_required");
  result = await publish(owner, `/_nap/api/naps/${slug}/versions`, "v1", { sourceCommit: v1 });
  assert.equal(result.status, 200, result.text);
  const liveV1 = result.json.version;

  // Someone else clones, pushes, and publishes with the live version they read.
  script(other, ["clone", slug, "theirs"]);
  const theirs = join(work, "theirs");
  assert.equal(await readFile(join(theirs, "index.html"), "utf8"), "<title>Source test</title>v1");
  await writeFile(join(theirs, "index.html"), "<title>Source test</title>v2");
  git(theirs, "commit", "-qam", "feat: second version");
  script(other, ["run", slug, "--", "git", "push", "-q", "origin", "main"], { cwd: theirs });
  const v2 = git(theirs, "rev-parse", "HEAD");

  // The owner's old commit is no longer the head.
  result = await publish(owner, `/_nap/api/naps/${slug}/versions`, "v1 again", {
    sourceCommit: v1,
  });
  assert.equal(result.json.code, "source_not_head");
  assert.equal(result.json.head, v2);
  result = await publish(other, `/_nap/api/naps/${slug}/versions`, "v2", {
    sourceCommit: v2,
    expectedVersion: liveV1,
  });
  assert.equal(result.status, 200, result.text);

  // The owner's stale push is rejected by git; a force-push lands, but cannot go live.
  await writeFile(join(source, "index.html"), "<title>Source test</title>v1b");
  git(source, "commit", "-qam", "feat: stale work");
  const push = script(owner, ["run", slug, "--", "git", "push", "-q", "origin", "main"], {
    cwd: source,
    allowFailure: true,
  });
  assert.notEqual(push.status, 0, "a stale push is rejected");
  script(owner, ["run", slug, "--", "git", "push", "-q", "--force", "origin", "main"], {
    cwd: source,
  });
  const forced = git(source, "rev-parse", "HEAD");
  result = await publish(owner, `/_nap/api/naps/${slug}/versions`, "forced", {
    sourceCommit: forced,
  });
  assert.equal(result.json.code, "source_not_descendant");

  // Recover: merge the dropped commit back in, push, publish.
  script(owner, ["run", slug, "--", "git", "fetch", "-q", join(work, "theirs"), "main"], {
    cwd: source,
  });
  git(source, "merge", "-q", "-X", "theirs", "--no-edit", "FETCH_HEAD");
  script(owner, ["run", slug, "--", "git", "push", "-q", "origin", "main"], { cwd: source });
  const merged = git(source, "rev-parse", "HEAD");
  result = await publish(owner, `/_nap/api/naps/${slug}/versions`, "merged", {
    sourceCommit: merged,
  });
  assert.equal(result.status, 200, result.text);

  // jj pushes with the same environment, when it is installed.
  if (spawnSync("jj", ["--version"]).status === 0) {
    const jjDir = join(work, "jj");
    script(owner, [
      "run",
      slug,
      "--",
      "jj",
      "git",
      "clone",
      "--quiet",
      info.json.source.remote,
      jjDir,
    ]);
    execFileSync("jj", ["new", "main", "-m", "feat: from jj", "--quiet"], { cwd: jjDir });
    await writeFile(join(jjDir, "index.html"), "<title>Source test</title>jj");
    execFileSync("jj", ["bookmark", "set", "main", "-r", "@", "--quiet"], { cwd: jjDir });
    script(owner, ["run", slug, "--", "jj", "git", "push", "--quiet", "-b", "main"], {
      cwd: jjDir,
    });
    const head = execFileSync("jj", ["log", "-r", "main", "--no-graph", "-T", "commit_id"], {
      cwd: jjDir,
      encoding: "utf8",
    });
    result = await publish(owner, `/_nap/api/naps/${slug}/versions`, "jj", {
      sourceCommit: head,
    });
    assert.equal(result.status, 200, result.text);
  }

  const synced = await send(`/_nap/api/naps/${slug}/source`, {
    headers: { authorization: `Bearer ${other}` },
  });
  assert.equal(synced.json.source.inSync, true, synced.text);

  // A read token cannot push.
  const read = await postJson(
    `/_nap/api/naps/${slug}/source/token`,
    { access: "read" },
    { authorization: `Bearer ${owner}` },
  );
  assert.equal(read.json.source.scope, "read");
  const denied = spawnSync("git", ["push", "-q", "origin", "HEAD:refs/heads/nope"], {
    cwd: source,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${read.json.source.token}`,
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    },
  });
  assert.notEqual(denied.status, 0, "a read token cannot push");

  console.log(
    `Source repo checks passed against Artifacts namespace ${NAMESPACE}: create, tokens, git and jj, head and ancestry checks.`,
  );
} finally {
  await nap?.stop();
  if (repo) {
    const removed = spawnSync(
      "cf",
      ["artifacts", "namespaces", "repos", "delete", repo, "--namespace", NAMESPACE, "--force"],
      { encoding: "utf8" },
    );
    // cf exits 0 when it aborts a delete, so check what it says too.
    if (removed.status !== 0 || /Aborted/.test(removed.stdout + removed.stderr))
      console.error(`Could not delete the test repo ${NAMESPACE}/${repo}: ${removed.stderr}`);
  }
  await rm(state, { recursive: true, force: true });
}
// The runtime's platform proxy leaves a local server open after dispose().
process.exit(0);
