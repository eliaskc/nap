// Checks what Nap's frame does for a page, in a real browser against Nap on a new local Alchemy
// stage: switching themes from the Nap bar, and a deck of slides in Nap's slides shell. Needs
// Google Chrome, or CHROME_PATH.
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

const DECK = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Deck</title>
<style>.slide { padding: 100px; font: 60px system-ui; } .box { position: absolute; width: 200px; height: 200px; background: teal; }</style>
<script src="/_nap/slides.js" defer></script>
</head>
<body>
<section class="slide" id="intro" data-transition="magic"><h1>Intro</h1><div class="box" data-magic="box" style="left:100px;top:400px"></div><aside>Say hello.</aside></section>
<section class="slide" id="points"><h1>Points</h1><p class="fragment">One</p><p class="fragment">Two</p><div class="box" data-magic="box" style="left:1500px;top:700px"></div></section>
<section class="slide"><h1>End</h1><div data-island="late"></div></section>
<script>document.querySelector("[data-island=late]").textContent = "Drawn by the deck";</script>
</body>
</html>`;

async function slides(context, token) {
  const deck = await publish(token, "title=Deck&type=slides&access=private", DECK);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("page error:", error));
  await page.goto(`http://localhost:${PORT}/${deck}`);
  const count = page.locator("#nap-slides-slot .count");
  await count.waitFor();
  const frame = napFrame(page);
  const host = frame.locator("nap-deck");
  const shown = () =>
    frame.evaluate(() => document.querySelector("nap-deck > section[data-current] h1").textContent);
  const state = () =>
    frame.evaluate(() => ({
      presenting: document.querySelector("nap-deck").hasAttribute("data-present"),
      fragments: document.querySelectorAll("nap-deck > section[data-current] .fragment.visible")
        .length,
    }));

  // The shell lays the deck out: a column with a still copy of every slide, the first one on
  // the stage, and its notes. The Nap bar shows the place in the deck.
  assert.equal(await count.textContent(), "1 / 3");
  assert.equal(await page.locator("#nap-slides-slot button").textContent(), "Present");
  assert.equal(await host.locator(".thumbs button").count(), 3);
  assert.equal(await shown(), "Intro");
  assert.equal(await host.locator("textarea").inputValue(), "Say hello.");
  // The copies are stills: no ids, and what the deck's own script drew is in them.
  assert.equal(await frame.locator("[data-nap-thumb] [id]").count(), 0);
  await until(
    async () =>
      (await frame.locator("[data-nap-thumb]").nth(2).textContent()).includes("Drawn by the deck"),
    "the column shows what the deck drew",
  );

  // Arrow keys move through the deck. Out of the show, a slide is complete: all its fragments.
  await host.locator(".thumbs button").first().focus();
  await page.keyboard.press("ArrowRight");
  await until(async () => (await count.textContent()) === "2 / 3", "the bar follows");
  assert.equal(await shown(), "Points");
  assert.deepEqual(await state(), { presenting: false, fragments: 2 });
  await until(async () => page.url().endsWith(`/${deck}#slide-2`), "the address names the slide");
  assert.equal(await host.locator("textarea").inputValue(), "");

  // Presenting: fragments come one step at a time, then the next slide.
  await page.keyboard.press("f");
  await until(async () => (await state()).presenting, "the show starts");
  assert.equal((await state()).fragments, 0);
  await page.keyboard.press("ArrowRight");
  assert.equal((await state()).fragments, 1);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.equal(await shown(), "End");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await shown(), "Points");
  assert.equal((await state()).fragments, 2, "back lands on the finished slide");
  await page.keyboard.press("Escape");
  await until(async () => !(await state()).presenting, "the show ends");

  // Notes people write are kept on Nap, by the slide's id.
  await page.keyboard.press("Home");
  await host.locator("textarea").fill("Say hello, then pause.");
  await until(
    async () => (await host.locator(".saved").textContent()) === "Saved",
    "the note saves",
  );
  await page.goto("about:blank");
  await page.goto(`http://localhost:${PORT}/${deck}#slide-3`);
  await until(async () => (await count.textContent()) === "3 / 3", "a link opens its slide");
  const again = napFrame(page);
  await again.locator("nap-deck .thumbs button").first().click();
  await until(
    async () =>
      (await again.locator("nap-deck textarea").inputValue()) === "Say hello, then pause.",
    "the note is still there",
  );

  // Printing (the PDF): every slide, one a page, without the shell's own parts.
  await page.emulateMedia({ media: "print" });
  const printed = await again.evaluate(() => ({
    slides: Array.from(document.querySelectorAll("nap-deck > section")).filter(
      (slide) =>
        getComputedStyle(slide).visibility === "visible" &&
        slide.getBoundingClientRect().height > 0,
    ).length,
    rail: getComputedStyle(document.querySelector("nap-deck").shadowRoot.querySelector(".rail"))
      .display,
  }));
  assert.deepEqual(printed, { slides: 3, rail: "none" });
  await page.close();
}

assert.ok(CHROME, "Google Chrome not found: set CHROME_PATH");
let nap;
let browser;
try {
  nap = await startLocalNap({ port: PORT, label: "frame" });
  const token = await signIn();
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext();
  // Sign the browser in as the owner on Nap's own pages. The frame has no sign-in: its token is
  // in its URLs, and an extra header on its requests would only add a CORS preflight.
  await context.route("**/*", (route) => {
    const request = route.request();
    if (request.url().includes("/_nap/frame/")) return route.continue();
    return route.continue({ headers: { ...request.headers(), "x-nap-dev-email": OWNER } });
  });
  await themes(context, token);
  await slides(context, token);
  console.log("Frame browser checks passed: themes and slides.");
} finally {
  await browser?.close();
  await nap?.stop();
}
