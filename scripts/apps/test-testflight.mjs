// End-to-end check of TestFlight: Nap on a new local Alchemy stage, set up as a TestFlight-only
// instance (napConfig.apps.testFlight, no profileName), with its SOURCES binding pointed at an
// Artifacts test namespace and the signer image in local Docker. It creates the TestFlight app
// from the template, builds the launcher with Xcode, publishes it, and waits until Apple has
// processed the build for TestFlight. The template prototype declares capabilities: Nap turns
// Wi-Fi information on for the App ID (and the test turns it off again if it was off), and the
// publish warns about the ones it cannot turn on.
//
// This uploads a real build to the instance's app in App Store Connect: its internal testers get
// it. Run it against an instance whose testers expect test builds.
//
// Needs what `pnpm test:apps` needs (Xcode, Tuist, Docker, git, the cf CLI, Artifacts access in
// NAP_ALCHEMY_PROFILE, the signing secrets in the environment), an instance/ with testFlight and
// without profileName, and a signer at NAP_SIGNER_URL:
//   docker run --rm -p 18080:8080 -e SIGNING_PEM="$NAP_APPLE_SIGNING_PEM" nap-signer
//   NAP_SIGNER_URL=http://localhost:18080 pnpm test:testflight
import { spawnSync } from "node:child_process";
import { createPrivateKey, createSign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { napConfig } from "../../nap.config.ts";
import { startLocalNap } from "../lib/local-nap.mjs";

const PORT = 8798;
const ORIGIN = `http://localhost:${PORT}`;
const NAMESPACE = process.env.NAP_SOURCES_TEST_NAMESPACE || "nap-sites-test";
if (NAMESPACE === "nap-sites") throw new Error("Never run this against the production namespace");
const testFlight = napConfig.apps?.testFlight;
if (!testFlight || napConfig.apps?.profileName) {
  throw new Error("instance/ must have apps.testFlight and no apps.profileName");
}
for (const name of [
  "NAP_APPLE_SIGNING_PEM",
  "NAP_ASC_PRIVATE_KEY",
  "NAP_ASC_KEY_ID",
  "NAP_ASC_ISSUER_ID",
  "NAP_SIGNER_URL",
]) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
}

const state = await mkdtemp(join(tmpdir(), "nap-testflight-test-"));
const work = join(state, "work");
await mkdir(work);
const APP = testFlight.app;
const gitIdentity = {
  GIT_AUTHOR_NAME: "Nap test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Nap test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** App Store Connect, to check and undo what the test turns on. */
async function appStoreConnect(path, init = {}) {
  const key = createPrivateKey(process.env.NAP_ASC_PRIVATE_KEY.replace(/\\n/g, "\n"));
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "ES256", kid: process.env.NAP_ASC_KEY_ID, typ: "JWT" })}.${b64({
    iss: process.env.NAP_ASC_ISSUER_ID,
    iat,
    exp: iat + 600,
    aud: "appstoreconnect-v1",
  })}`;
  const signature = createSign("SHA256")
    .update(input)
    .sign({ key, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  const response = await fetch(`https://api.appstoreconnect.apple.com/v1/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${input}.${signature}`, "content-type": "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function appIdCapabilities() {
  const bundles = await appStoreConnect(
    `bundleIds?filter[identifier]=${encodeURIComponent(testFlight.bundleId)}&limit=20`,
  );
  const bundle = bundles.data.find((item) => item.attributes.identifier === testFlight.bundleId);
  const list = await appStoreConnect(`bundleIds/${bundle.id}/bundleIdCapabilities`);
  return new Map(list.data.map((item) => [item.attributes.capabilityType, item.id]));
}

/** Makes the App Store profile again, as Nap does, so it drops a capability that was turned off. */
async function regenerateAppStoreProfile() {
  const list = await appStoreConnect(
    `profiles?filter[name]=${encodeURIComponent(testFlight.profileName)}&filter[profileType]=IOS_APP_STORE&limit=10`,
  );
  // Turning a capability off makes the profile invalid; it stays the one to replace.
  const named = list.data.filter((item) => item.attributes.name === testFlight.profileName);
  const old = named.find((item) => item.attributes.profileState === "ACTIVE") ?? named[0];
  const [bundle, certificates] = await Promise.all([
    appStoreConnect(`profiles/${old.id}/bundleId`),
    appStoreConnect(`profiles/${old.id}/certificates`),
  ]);
  await appStoreConnect(`profiles/${old.id}`, { method: "DELETE" });
  await appStoreConnect("profiles", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "profiles",
        attributes: { name: testFlight.profileName, profileType: "IOS_APP_STORE" },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundle.data.id } },
          certificates: {
            data: certificates.data.map((item) => ({ type: "certificates", id: item.id })),
          },
        },
      },
    }),
  });
}

/** One request on a fresh connection: the local dev server resets reused keep-alive sockets. */
function call(path, { method = "GET", token, json, headers = {} } = {}) {
  const payload = json ? Buffer.from(JSON.stringify(json)) : undefined;
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
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode, text, json: parsed });
        });
      },
    );
    req.setTimeout(300_000, () => req.destroy(new Error(`Timeout: ${method} ${path}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function signIn(email) {
  const start = await call("/_nap/api/auth/device", {
    method: "POST",
    json: { client: "testflight test" },
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
    cwd: work,
    env: { ...process.env, NAP_URL: ORIGIN, NAP_TOKEN: token, ...gitIdentity },
  });
  if (!options.allowFailure)
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function build(dir, target) {
  const result = spawnSync(join(dir, "scripts/build"), [target], { encoding: "utf8", cwd: dir });
  assert.equal(result.status, 0, `build ${target}\n${result.stdout}\n${result.stderr}`);
  return join(dir, result.stdout.trim().split("\n").pop());
}

let nap;
let repo;
let turnedOnWifi = false;
const step = (name) => console.log(`- ${name}`);
try {
  nap = await startLocalNap({
    port: PORT,
    label: "testflight",
    profile: process.env.NAP_ALCHEMY_PROFILE || "nap",
    vars: { NAP_SOURCES_NAMESPACE: NAMESPACE, NAP_SIGNER_URL: process.env.NAP_SIGNER_URL },
    timeout: 600_000,
  });
  const script_ = await call("/_nap/api/publish.mjs");
  await writeFile(join(state, "publish.mjs"), script_.text);
  const token = await signIn("owner@example.com");

  step("without ad hoc, Nap has one app: the TestFlight one");
  const other = script(token, ["app", "init", "other", "other"], { allowFailure: true });
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /has one app/);

  step(`app init creates ${APP} from the template, icon included`);
  script(token, ["app", "init", APP, APP, "--title", "TestFlight test"]);
  const dir = join(work, APP);
  repo = (await call(`/_nap/api/apps/${APP}`, { token })).json.source.repo;

  step("the template prototype declares a permission and capabilities in prototype.json");
  turnedOnWifi = !(await appIdCapabilities()).has("ACCESS_WIFI_INFORMATION");
  await writeFile(
    join(dir, "Prototypes/hello/prototype.json"),
    JSON.stringify({
      title: "Hello",
      permissions: { NSMotionUsageDescription: "The TestFlight test asks for nothing." },
      capabilities: ["wifi-info", "icloud", "teleport"],
    }),
  );
  const built = build(dir, "launcher");
  const unzipped = join(state, "unzipped");
  spawnSync("unzip", ["-q", "-o", built, "-d", unzipped]);
  const plist = spawnSync(
    "sh",
    [
      "-c",
      `plutil -convert json -o - "${unzipped}"/*.app/Info.plist 2>/dev/null || plutil -convert json -o - "${unzipped}"/*/*.app/Info.plist`,
    ],
    { encoding: "utf8" },
  );
  const info = JSON.parse(plist.stdout);
  assert.equal(info.NSMotionUsageDescription, "The TestFlight test asks for nothing.");
  assert.deepEqual(info.NapCapabilities, { hello: ["wifi-info", "icloud", "teleport"] });
  for (const args of [
    ["add", "-A"],
    ["commit", "-qm", "test: capabilities"],
  ]) {
    const git = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...gitIdentity },
    });
    assert.equal(git.status, 0, git.stderr);
  }

  step("publishing the launcher signs it for the App Store and uploads it to TestFlight");
  const published = script(token, [
    "app",
    "publish",
    APP,
    build(dir, "launcher"),
    "--target",
    "launcher",
    "--source",
    dir,
    "--notes",
    "TestFlight test",
  ]);
  assert.match(published.stdout, /uploaded to TestFlight/);

  step("Nap turned Wi-Fi information on, and warns about iCloud and the unknown name");
  assert.ok((await appIdCapabilities()).has("ACCESS_WIFI_INFORMATION"));
  assert.match(published.stdout, /iCloud needs an iCloud container/);
  assert.match(published.stdout, /teleport is not a capability Nap knows/);
  assert.doesNotMatch(published.stdout, /Wi-Fi information/);
  const buildNumber = Number(published.stdout.match(/Build (\d+) of launcher/)[1]);
  assert.ok(buildNumber > 1, "the build number goes above what App Store Connect has");

  step("other targets are not published, and there are no install links");
  const standalone = script(
    token,
    ["app", "publish", APP, build(dir, "launcher"), "--target", "hello", "--source", dir],
    { allowFailure: true },
  );
  assert.notEqual(standalone.status, 0);
  assert.match(standalone.stderr, /only publishes the launcher/);
  const install = await call(`/api/apps/${APP}/launcher/install`, {
    method: "POST",
    headers: { "x-nap-dev-email": "owner@example.com", "sec-fetch-site": "same-origin" },
  });
  assert.equal(install.status, 404, install.text);

  step("the dashboard shows the build processing, then in TestFlight");
  const started = Date.now();
  let status;
  for (;;) {
    const apps = await call("/api/apps", { headers: { "x-nap-dev-email": "owner@example.com" } });
    assert.equal(apps.status, 200, apps.text);
    assert.equal(apps.json.adHoc, false);
    assert.match(apps.json.testFlight.url, new RegExp(`/app/${testFlight.appStoreId}$`));
    const live = apps.json.apps.find((app) => app.slug === APP).targets[0].live;
    assert.equal(live.buildNumber, buildNumber);
    status = live.testFlight;
    if (status.state !== "processing") break;
    if (Date.now() - started > 30 * 60_000) throw new Error("Apple took over 30 minutes");
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  assert.equal(status.state, "ready", status.error);
  console.log(
    `  build ${buildNumber} in TestFlight after ${Math.round((Date.now() - started) / 1000)} s`,
  );

  console.log("TestFlight test passed.");
} finally {
  await nap?.stop();
  if (turnedOnWifi) {
    try {
      const id = (await appIdCapabilities()).get("ACCESS_WIFI_INFORMATION");
      if (id) {
        await appStoreConnect(`bundleIdCapabilities/${id}`, { method: "DELETE" });
        await regenerateAppStoreProfile();
      }
    } catch (error) {
      console.error(`Turn Wi-Fi information off for ${testFlight.bundleId} by hand: ${error}`);
    }
  }
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
