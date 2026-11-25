// Checks what Nap's frame does for a page, in a real browser against Nap on a new local Alchemy
// stage: switching themes from the Nap bar. Needs Google Chrome, or CHROME_PATH.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { chromium } from "playwright-core";
import { startLocalNap } from "../lib/local-nap.mjs";

const PORT = 8798;
const OWNER = "elias@example.test";
const CHROME =
  process.env.CHROME_PATH ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((path) => existsSync(path));

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
const json = (path, value, headers = {}) =>
  send(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });

async function signIn() {
  const start = JSON.parse((await json("/_nap/api/auth/device", { client: "frame test" })).text);
  const approved = await json(
    `/api/connect/${start.user_code}`,
    { action: "approve" },
    { "x-nap-dev-email": OWNER },
  );
  assert.equal(approved.status, 200, approved.text);
  const token = await json("/_nap/api/auth/token", { device_code: start.device_code });
  // People without a name go to the welcome page first.
  const dev = { "x-nap-dev-email": OWNER };
  await send("/api/me", { headers: dev });
  const named = await send("/api/me", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...dev },
    body: JSON.stringify({ displayName: "Elias" }),
  });
  assert.equal(named.status, 200, named.text);
  return JSON.parse(token.text).token;
}

async function publish(token, query, body) {
  const created = await send(`/_nap/api/naps?${query}`, {
    method: "POST",
    headers: { "content-type": "text/html", authorization: `Bearer ${token}` },
    body,
  });
  assert.equal(created.status, 201, created.text);
  return JSON.parse(created.text).id;
}

async function until(check, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check().catch((error) => String(error));
    if (last === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label} (${last})`);
}

/** The nap's own frame: the sandboxed one, at /_nap/frame/<token>/. */
const napFrame = (page) => page.frames().find((frame) => frame.url().includes("/_nap/frame/"));
const themeOf = (page) => napFrame(page).evaluate(() => document.documentElement.dataset.theme);

const THEMED = `<!doctype html>
<html data-theme="vivid">
<head>
<meta charset="utf-8">
<meta name="nap-themes" content="vivid=Vivid,plain=Plain" />
<title>Themed</title>
<script>window.firstTheme = document.documentElement.dataset.theme;</script>
</head>
<body><h1>Themed</h1><script>window.bodyTheme = document.documentElement.dataset.theme;</script></body>
</html>`;
const UNTHEMED = `<!doctype html><html data-theme="own"><title>Own look</title><h1>Own look</h1></html>`;

async function themes(context, token) {
  const themed = await publish(token, "title=Themed&access=private", THEMED);
  const unthemed = await publish(token, "title=Own&access=private", UNTHEMED);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("page error:", error));

  // A page that lists its themes gets the choice in the bar, on its default.
  await page.goto(`http://localhost:${PORT}/${themed}`);
  const select = page.locator("#nap-theme-slot select");
  await select.waitFor();
  assert.deepEqual(await select.locator("option").allTextContents(), ["Vivid", "Plain"]);
  assert.equal(await select.inputValue(), "vivid");
  assert.equal(await themeOf(page), "vivid");

  // Choosing one changes the page in place.
  await select.selectOption("plain");
  await until(async () => (await themeOf(page)) === "plain", "the page switches to plain");

  // The choice is the person's (a cookie): the page starts in it next time, before its body runs.
  await page.reload();
  await select.waitFor();
  await until(async () => (await select.inputValue()) === "plain", "the bar shows plain");
  assert.equal(await themeOf(page), "plain");
  assert.equal(
    await napFrame(page).evaluate(() => window.bodyTheme),
    "plain",
    "set before the body",
  );

  // A page without the list does not switch, and gets no control.
  await page.goto(`http://localhost:${PORT}/${unthemed}`);
  await until(async () => Boolean(napFrame(page)), "the frame loads");
  await napFrame(page).waitForSelector("h1");
  assert.equal(await page.locator("#nap-theme-slot select").count(), 0);
  assert.equal(await themeOf(page), "own");
  await page.close();
}

assert.ok(CHROME, "Google Chrome not found: set CHROME_PATH");
let nap;
let browser;
try {
  nap = await startLocalNap({ port: PORT, label: "frame" });
  const token = await signIn();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ extraHTTPHeaders: { "x-nap-dev-email": OWNER } });
  await themes(context, token);
  console.log("Frame browser checks passed: themes.");
} finally {
  await browser?.close();
  await nap?.stop();
}
