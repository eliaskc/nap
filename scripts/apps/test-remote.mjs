// End-to-end check of native apps: Nap on a new local Alchemy stage (its own D1/R2), with its
// SOURCES binding pointed at an Artifacts test namespace and the signer container running in local
// Docker. It creates an app from the template with publish.mjs, builds the launcher with Xcode,
// publishes it, checks the commit rules, and downloads the signed .ipa through an install link.
//
// Needs: a Mac with Xcode, Tuist (mise), Docker, git, the cf CLI (NAP_CF_PROFILE picks its auth
// profile), Cloudflare credentials with
// Artifacts access in the Alchemy profile NAP_ALCHEMY_PROFILE (default nap), and the signing
// secrets in the environment: NAP_APPLE_SIGNING_PEM, NAP_ASC_PRIVATE_KEY, NAP_ASC_KEY_ID,
// NAP_ASC_ISSUER_ID. Repos go in NAP_SOURCES_TEST_NAMESPACE (default nap-sites-test) and are
// deleted at the end. It never touches production.
//
// workerd's local containers need a Docker engine with transparent proxying (Docker Desktop). On
// others (OrbStack), run the signer image yourself and set NAP_SIGNER_URL:
//   docker build -t nap-signer containers/signer
//   docker run --rm -p 18080:8080 -e SIGNING_PEM="$NAP_APPLE_SIGNING_PEM" nap-signer
//   NAP_SIGNER_URL=http://localhost:18080 pnpm test:apps
import { execFileSync, spawnSync } from "node:child_process";
import { napConfig } from "../../nap.config.ts";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startLocalNap } from "../lib/local-nap.mjs";

const PORT = 8797;
const ORIGIN = `http://localhost:${PORT}`;
const NAMESPACE = process.env.NAP_SOURCES_TEST_NAMESPACE || "nap-sites-test";
if (NAMESPACE === "nap-sites") throw new Error("Never run this against the production namespace");
for (const name of [
  "NAP_APPLE_SIGNING_PEM",
  "NAP_ASC_PRIVATE_KEY",
  "NAP_ASC_KEY_ID",
  "NAP_ASC_ISSUER_ID",
]) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
}

const state = await mkdtemp(join(tmpdir(), "nap-apps-test-"));
const work = join(state, "work");
await mkdir(work);
const APP = `test-${process.pid}`;
const gitIdentity = {
  GIT_AUTHOR_NAME: "Nap test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Nap test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** One request on a fresh connection: the local dev server resets reused keep-alive sockets. */
function call(path, { method = "GET", token, json, headers = {}, body } = {}) {
  const payload = json ? Buffer.from(JSON.stringify(json)) : body;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        path,
        method,
        agent: false,
        headers: {
          host: `localhost:${PORT}`,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(json ? { "content-type": "application/json" } : {}),
          ...(payload ? { "content-length": payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString("utf8");
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode, text, json: parsed, buffer });
        });
      },
    );
    req.setTimeout(120_000, () => req.destroy(new Error(`Timeout: ${method} ${path}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function signIn(email) {
  const start = await call("/_nap/api/auth/device", {
    method: "POST",
    json: { client: "apps test" },
  });
  assert.equal(start.status, 200, start.text);
  const approved = await call(`/api/connect/${start.json.user_code}`, {
    method: "POST",
    json: { action: "approve" },
    headers: { "x-nap-dev-email": email },
  });
  assert.equal(approved.status, 200, approved.text);
  const token = await call("/_nap/api/auth/token", {
    method: "POST",
    json: { device_code: start.json.device_code },
  });
  assert.equal(token.status, 200, token.text);
  return token.json.token;
}

function script(token, args, options = {}) {
  const result = spawnSync("node", [join(state, "publish.mjs"), ...args], {
    encoding: "utf8",
    cwd: options.cwd ?? work,
    env: { ...process.env, NAP_URL: ORIGIN, NAP_TOKEN: token, ...gitIdentity },
  });
  if (!options.allowFailure)
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...gitIdentity },
  }).trim();

function build(dir, target) {
  const result = spawnSync(join(dir, "scripts/build"), [target], { encoding: "utf8", cwd: dir });
  assert.equal(result.status, 0, `build ${target}\n${result.stdout}\n${result.stderr}`);
  return join(dir, result.stdout.trim().split("\n").pop());
}

let nap;
let repo;
const step = (name) => console.log(`- ${name}`);
try {
  nap = await startLocalNap({
    port: PORT,
    label: "apps",
    profile: process.env.NAP_ALCHEMY_PROFILE || "nap",
    vars: {
      NAP_SOURCES_NAMESPACE: NAMESPACE,
      ...(process.env.NAP_SIGNER_URL ? { NAP_SIGNER_URL: process.env.NAP_SIGNER_URL } : {}),
    },
    timeout: 600_000,
  });
  const script_ = await call("/_nap/api/publish.mjs");
  await writeFile(join(state, "publish.mjs"), script_.text);
  const token = await signIn("owner@example.com");
  const other = await signIn("other@example.com");

  step("app init creates the app and its repo, and pushes the template");
  script(token, ["app", "init", APP, APP, "--title", "Apps test"]);
  const dir = join(work, APP);
  const info = await call(`/_nap/api/apps/${APP}`, { token });
  assert.equal(info.status, 200, info.text);
  repo = info.json.source.repo;
  assert.equal(info.json.source.head, git(dir, "rev-parse", "HEAD"));

  step("publishing the launcher signs it and makes build 1 live");
  const zip = build(dir, "launcher");
  const published = script(token, [
    "app",
    "publish",
    APP,
    zip,
    "--target",
    "launcher",
    "--source",
    dir,
    "--notes",
    "First",
  ]);
  assert.match(published.stdout, /Build 1 of launcher is live/);

  step("someone else's build of the same commit is build 2");
  script(other, ["app", "publish", APP, zip, "--target", "launcher", "--source", dir]);

  step("a commit that is not the head of main is refused");
  await writeFile(join(dir, "Prototypes/hello/prototype.json"), '{ "title": "Hello 2" }\n');
  git(dir, "commit", "-qam", "chore: change the title");
  const unpushed = git(dir, "rev-parse", "HEAD");
  const stale = await call(
    `/_nap/api/apps/${APP}/builds?target=launcher&sourceCommit=${unpushed}`,
    {
      method: "POST",
      token,
      headers: { "content-type": "application/zip" },
      body: await readFile(zip),
    },
  );
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.code, "source_not_head");

  step("pushing and publishing it makes build 3 live");
  script(token, [
    "app",
    "publish",
    APP,
    build(dir, "launcher"),
    "--target",
    "launcher",
    "--source",
    dir,
  ]);

  step("a Simulator build is refused by the signer");
  const sim = spawnSync(
    "sh",
    [
      "-c",
      `xcodebuild build -project NapApps.xcodeproj -scheme Launcher -sdk iphonesimulator -derivedDataPath .build/Sim CODE_SIGNING_ALLOWED=NO -quiet >/dev/null 2>&1 && ditto -c -k --keepParent .build/Sim/Build/Products/Debug-iphonesimulator/Nap.app build/sim.zip`,
    ],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(sim.status, 0, sim.stderr);
  const refused = script(
    token,
    ["app", "publish", APP, join(dir, "build/sim.zip"), "--target", "launcher", "--source", dir],
    { allowFailure: true },
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /iphonesimulator/);

  step("a force-push that drops the live commit cannot go live");
  const live = (await call(`/_nap/api/apps/${APP}`, { token })).json.app.targets[0].live;
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  await writeFile(join(dir, "README.md"), "rewritten\n");
  git(dir, "commit", "-qam", "chore: rewrite history");
  script(token, ["app", "run", APP, "--", "git", "-C", dir, "push", "-f", "nap", "HEAD:main"]);
  const dropped = script(
    token,
    ["app", "publish", APP, build(dir, "launcher"), "--target", "launcher", "--source", dir],
    { allowFailure: true },
  );
  assert.notEqual(dropped.status, 0);
  assert.match(dropped.stderr, /not in the history/);
  assert.equal(live.buildNumber, 3);

  step("an install link serves the manifest and the signed .ipa without a session");
  const target = await call(`/_nap/api/apps/${APP}/targets/launcher`, { token });
  assert.equal(target.status, 200, target.text);
  const manifestUrl = decodeURIComponent(target.json.install.url.split("url=")[1]);
  const manifest = await call(new URL(manifestUrl).pathname);
  assert.equal(manifest.status, 200);
  assert.ok(manifest.text.includes(`${napConfig.apps.bundleIdPrefix}.launcher`));
  const ipaUrl = manifest.text.match(/<string>(http[^<]+app\.ipa)<\/string>/)[1];
  const ipa = await call(new URL(ipaUrl).pathname);
  assert.equal(ipa.status, 200);
  const ipaPath = join(state, "app.ipa");
  await writeFile(ipaPath, ipa.buffer);
  execFileSync("unzip", ["-q", ipaPath, "-d", join(state, "ipa")]);
  const verify = spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", join(state, "ipa/Payload/Nap.app")],
    { encoding: "utf8" },
  );
  assert.equal(verify.status, 0, verify.stderr);
  const plist = execFileSync("plutil", ["-p", join(state, "ipa/Payload/Nap.app/Info.plist")], {
    encoding: "utf8",
  });
  assert.match(plist, /"CFBundleVersion" => "3"/);
  const bad = await call(`/_nap/install/${"x".repeat(43)}/manifest.plist`);
  assert.equal(bad.status, 404);

  step("the dashboard lists the app");
  const dashboard = await call("/api/apps", {
    headers: { "x-nap-dev-email": "other@example.com" },
  });
  assert.equal(dashboard.json.apps.find((app) => app.slug === APP)?.targets[0].live.buildNumber, 3);

  console.log("Apps test passed.");
} finally {
  await nap?.stop();
  if (repo) {
    const deleted = spawnSync(
      "cf",
      [
        "artifacts",
        "namespaces",
        "repos",
        "delete",
        repo,
        "--namespace",
        NAMESPACE,
        "--force",
        ...(process.env.NAP_CF_PROFILE ? ["--profile", process.env.NAP_CF_PROFILE] : []),
      ],
      { encoding: "utf8" },
    );
    if (deleted.status !== 0)
      console.error(`Delete the test repo ${repo} by hand:\n${deleted.stderr}`);
  }
  await rm(state, { recursive: true, force: true });
}
