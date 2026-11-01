// Checks nap.voice in a real browser: two pages of one site join a call on Nap running on a new
// local Alchemy stage, connect with WebRTC, hear each other (Chrome's fake microphone plays a
// tone), mute, switch microphones, and leave. Needs Google Chrome, or CHROME_PATH.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { chromium } from "playwright-core";
import { startLocalNap } from "../lib/local-nap.mjs";

const PORT = 8797;
const SLUG = "voicetest";
const OWNER = "elias@example.test";
const CHROME =
  process.env.CHROME_PATH ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((path) => existsSync(path));

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Voice test</title>
<button id="join">Join</button>
<script src="/_nap/client.js"></script>
<script>
  window.call = nap.voice("test");
  window.errors = [];
  call.on("error", (error) => errors.push(error.status + " " + error.message));
  join.onclick = () => call.join().catch((error) => errors.push("join " + error.message));
</script>`;

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
        res.on("end", () => resolve({ status: res.statusCode, text: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function publishSite() {
  const draft = await send(`/_nap/drafts?slug=${SLUG}&title=Voice`, {
    method: "POST",
    headers: { "content-type": "text/html" },
    body: PAGE,
  });
  assert.equal(draft.status, 201, draft.text);
  const { id } = JSON.parse(draft.text);
  const claim = await send(`/api/drafts/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-nap-dev-email": OWNER },
    body: JSON.stringify({ title: "Voice", slug: SLUG, visibility: "everyone" }),
  });
  assert.equal(claim.status, 200, claim.text);
}

const state = (page) =>
  page.evaluate(() => ({
    status: call.status,
    muted: call.muted,
    input: call.input,
    inputs: call.inputs,
    errors,
    participants: call.participants.map((p) => ({
      self: p.self,
      muted: p.muted,
      speaking: p.speaking,
      connection: p.connection,
    })),
  }));

async function until(page, check, label, timeout = 20_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await state(page);
    if (check(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}\n${JSON.stringify(last, null, 2)}`);
}

const other = (s) => s.participants.find((p) => !p.self);

assert.ok(CHROME, "Google Chrome not found: set CHROME_PATH");
let nap;
let browser;
try {
  nap = await startLocalNap({ port: PORT, label: "voice" });
  await publishSite();

  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const context = await browser.newContext({ permissions: ["microphone"] });
  const engineRequests = [];
  context.on("request", (request) => {
    if (request.url().includes("/_nap/client-voice.js")) engineRequests.push(request.url());
  });
  const url = `http://localhost:${PORT}/s/${SLUG}/`;
  const alice = await context.newPage();
  const bob = await context.newPage();
  for (const page of [alice, bob]) {
    page.on("pageerror", (error) => console.error("page error:", error));
    await page.goto(url);
  }
  assert.match(engineRequests[0] ?? "", /client-voice\.js\?v=[0-9a-f]{12}$/, "loads the engine");

  await alice.click("#join");
  await until(alice, (s) => s.status === "joined", "alice joins");
  await bob.click("#join");

  // Both connect, and each hears the other's fake microphone.
  for (const [page, name] of [
    [alice, "alice"],
    [bob, "bob"],
  ]) {
    await until(page, (s) => other(s)?.connection === "connected", `${name} connects`);
    await until(page, (s) => other(s)?.speaking === true, `${name} hears the other`);
  }

  // Mute shows on the other page, and a muted person is never speaking.
  await alice.evaluate(() => call.setMuted(true));
  await until(bob, (s) => other(s)?.muted === true && !other(s).speaking, "bob sees alice muted");
  await alice.evaluate(() => call.setMuted(false));
  await until(bob, (s) => other(s)?.speaking === true, "bob hears alice again");

  // Another microphone, without reconnecting.
  const before = await state(alice);
  const next = before.inputs.find((input) => input.deviceId !== before.input);
  if (next) {
    await alice.evaluate((deviceId) => call.setInput(deviceId), next.deviceId);
    const after = await until(alice, (s) => s.input === next.deviceId, "alice switches input");
    assert.equal(other(after).connection, "connected", "still connected after switching");
    await until(bob, (s) => other(s)?.speaking === true, "bob hears the new microphone");
  } else {
    console.warn("Only one fake microphone: skipped switching inputs.");
  }

  // Leaving ends the call for the other page too.
  await alice.evaluate(() => call.leave());
  await until(alice, (s) => s.status === "idle" && s.participants.length === 1, "alice leaves");
  await until(bob, (s) => s.participants.length === 1, "bob sees alice leave");
  for (const page of [alice, bob]) assert.deepEqual((await state(page)).errors, []);

  // Joining again works.
  await alice.click("#join");
  await until(bob, (s) => other(s)?.connection === "connected", "alice rejoins");

  console.log(
    "Voice browser checks passed: join, connect, hear, mute, switch input, leave, rejoin.",
  );
} finally {
  await browser?.close();
  await nap?.stop();
}
