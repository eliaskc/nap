// Checks agent sign-in, tokens, the agent API, and version history against Nap on a new local
// Alchemy stage with its own D1/R2 store. Never touches production.
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { startLocalNap } from "../lib/local-nap.mjs";
import { napConfig } from "../../nap.config.ts";

const PORT = 8797;
const OWNER = "owner@example.com";
const OTHER = "other@example.com";

/** node:http, so tests control every header. */
function send(path, { method = "GET", host = "localhost", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    // A fixed length and a new connection for each request. The local dev proxy fails more
    // often with chunked bodies and reused connections.
    const length = body ? { "content-length": Buffer.byteLength(body) } : {};
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        path,
        method,
        headers: { host, ...length, ...headers },
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
          resolve({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error(`Timeout: ${method} ${host}${path}`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * The local dev proxy sometimes drops a request after the Worker answered an earlier one without
 * reading its body. The Worker never sees the dropped request, so sending it again is safe.
 * GETs that time out are sent again too: local R2 writes from the tests' own workerd can
 * stall the dev proxy for a moment.
 */
async function call(path, options = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await send(path, options).catch((error) => {
      if (
        attempt < 2 &&
        (options.method ?? "GET") === "GET" &&
        error.message.startsWith("Timeout")
      ) {
        return null;
      }
      throw error;
    });
    if (!res) continue;
    if (attempt < 3 && res.status === 503 && res.text.includes("restarted mid-request")) continue;
    return res;
  }
}

const as = (email) => ({ "x-nap-dev-email": email });
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const postJson = (path, value, headers = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
const html = (path, token, body) =>
  call(path, { method: "POST", headers: { "content-type": "text/html", ...bearer(token) }, body });

/** Runs the device flow: start, approve as `email`, exchange. */
async function signIn(email, client) {
  const start = await postJson("/_nap/api/auth/device", { client });
  assert.equal(start.status, 200, start.text);
  const approved = await postJson(
    `/api/connect/${start.json.user_code}`,
    { action: "approve" },
    as(email),
  );
  assert.equal(approved.status, 200, approved.text);
  const exchanged = await postJson("/_nap/api/auth/token", {
    device_code: start.json.device_code,
  });
  assert.equal(exchanged.status, 200, exchanged.text);
  return exchanged.json.token;
}

let nap;
try {
  nap = await startLocalNap({
    port: PORT,
    label: "agent-api",
    // Fake R2 credentials: the Worker signs direct upload URLs, and the test writes the files
    // to the local bucket itself, because there is no local S3 endpoint.
    vars: {
      NAP_R2_ACCOUNT_ID: "test-account",
      NAP_R2_BUCKET: "nap-sites-local",
      NAP_R2_ACCESS_KEY_ID: "test-key",
      NAP_R2_SECRET_ACCESS_KEY: "test-secret",
    },
  });

  // Public: the instructions. Everything else needs a token, and Access headers do not count.
  const instructions = await call("/_nap/api/instructions");
  assert.equal(instructions.status, 200);
  assert.match(instructions.headers["content-type"], /markdown/);
  assert.match(instructions.text, /publish\.mjs login/);
  for (const [, topic] of instructions.text.matchAll(/^- `([a-z]+)`:/gm)) {
    const page = await call(`/_nap/api/instructions/${topic}`);
    assert.equal(page.status, 200, `instructions topic ${topic}`);
  }
  assert.match((await call("/_nap/api/instructions/api")).text, /_nap\/api\/auth\/device/);
  assert.equal((await call("/_nap/api/instructions/nope")).status, 404);
  const skill = await call("/_nap/api/skill");
  assert.equal(skill.status, 200);
  assert.match(skill.text, /^---\nname: nap\n/);
  const anonymous = await call("/_nap/api/naps", {
    headers: { "cf-access-authenticated-user-email": OWNER, ...as(OWNER) },
  });
  assert.equal(anonymous.status, 401, "Access headers are not a login for the agent API");
  assert.equal(anonymous.json.code, "invalid_token");

  // Device flow.
  const start = await postJson("/_nap/api/auth/device", { client: "Pi on test-mbp" });
  assert.equal(start.status, 200, start.text);
  const { device_code: deviceCode, user_code: userCode } = start.json;
  assert.match(userCode, /^[B-Z]{4}-[B-Z]{4}$/);
  assert.equal(start.json.verification_uri_complete, `http://localhost/connect?code=${userCode}`);
  const poll = () => postJson("/_nap/api/auth/token", { device_code: deviceCode });
  assert.equal((await poll()).json.error, "authorization_pending");
  assert.equal((await poll()).json.error, "slow_down", "polling too fast");

  const typedCode = userCode.toLowerCase().replace("-", " ");
  const described = await call(`/api/connect/${encodeURIComponent(typedCode)}`, {
    headers: as(OWNER),
  });
  assert.equal(described.status, 200, described.text);
  assert.equal(described.json.request.clientName, "Pi on test-mbp");
  assert.equal(described.json.request.status, "pending");
  assert.equal(
    (
      await postJson(
        `/api/connect/${userCode}`,
        { action: "approve" },
        { ...as(OWNER), "sec-fetch-site": "same-site" },
      )
    ).status,
    403,
    "naps on other hosts cannot approve",
  );
  assert.equal(
    (
      await call(`/api/connect/${userCode}`, {
        method: "POST",
        headers: { "content-type": "text/plain", ...as(OWNER) },
        body: '{"action":"approve"}',
      })
    ).status,
    415,
    "approval needs a JSON body",
  );
  const approved = await postJson(`/api/connect/${userCode}`, { action: "approve" }, as(OWNER));
  assert.equal(approved.status, 200, approved.text);
  assert.equal(
    (await postJson(`/api/connect/${userCode}`, { action: "approve" }, as(OTHER))).status,
    409,
    "a code is approved once",
  );
  const exchanged = await poll();
  assert.equal(exchanged.status, 200, exchanged.text);
  const token = exchanged.json.token;
  assert.match(token, /^nap_[A-Za-z0-9_-]{43}$/);
  assert.equal(exchanged.json.email, OWNER);
  assert.equal((await poll()).json.error, "invalid_grant", "a code gives one token");

  // Denied codes give nothing.
  const denied = await postJson("/_nap/api/auth/device", { client: "Unknown" });
  await postJson(`/api/connect/${denied.json.user_code}`, { action: "deny" }, as(OWNER));
  assert.equal(
    (await postJson("/_nap/api/auth/token", { device_code: denied.json.device_code })).json.error,
    "access_denied",
  );

  const me = await call("/_nap/api/me", { headers: bearer(token) });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.json.email, OWNER);
  assert.equal(me.json.client, "Pi on test-mbp");

  // Publish: unlisted, an artifact by default. access=private keeps it to the owner.
  const created = await html("/_nap/api/naps?title=Report&access=private", token, "<h1>v1</h1>");
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.kind, "artifact");
  assert.match(created.json.id, /^[a-z0-9]{12}$/, "artifacts get a random id");
  assert.equal(created.json.url, `http://localhost/artifact/${created.json.id}`);
  const id = created.json.id;
  const v1 = created.json.version;
  const dashboardRow = async (email = OWNER) =>
    (await call("/api/sites", { headers: as(email) })).json.sites.find((site) => site.slug === id);
  const row = await dashboardRow();
  assert.equal(row.visibility, "private", "access=private keeps it to the owner");
  assert.equal(row.listed, false);
  assert.equal(row.toolbar, true);

  const site = await html("/_nap/api/naps?slug=agent-site", token, "<title>Map</title>map");
  assert.equal(site.status, 201, site.text);
  assert.equal(site.json.kind, "site", "a slug makes a site");
  assert.equal(site.json.access, napConfig.defaultAccess, "new naps get the default access");
  assert.equal(site.json.id, "agent-site");
  assert.equal(site.json.title, "Map", "title from <title>");
  assert.equal(
    (await html("/_nap/api/naps?slug=other&kind=artifact", token, "x")).status,
    400,
    "a slug means a site",
  );
  assert.equal((await html("/_nap/api/naps?slug=api", token, "x")).status, 409, "reserved");

  // Access on create: everyone, or selected people. Never on updates.
  const visibilityOf = async (slug) =>
    (await call("/api/sites", { headers: as(OWNER) })).json.sites.find((s) => s.slug === slug)
      ?.visibility;
  const everyone = await html("/_nap/api/naps?title=Open&access=everyone", token, "<h1>open</h1>");
  assert.equal(everyone.status, 201, everyone.text);
  assert.equal(everyone.json.access, "everyone");
  assert.equal(await visibilityOf(everyone.json.id), "everyone", "agents can publish to everyone");
  const invited = await html(
    `/_nap/api/naps?title=Invited&access=selected&emails=${encodeURIComponent(` ${OTHER.toUpperCase()}, `)}`,
    token,
    "<h1>invited</h1>",
  );
  assert.equal(invited.status, 201, invited.text);
  assert.equal(await visibilityOf(invited.json.id), "selected");
  const invitedAccess = await call(`/artifact/${invited.json.id}/_nap/access`, {
    headers: as(OWNER),
  });
  assert.deepEqual(invitedAccess.json.viewerEmails, [OTHER]);
  for (const query of [
    "access=public",
    "access=selected",
    "access=selected&emails=nope",
    "emails=" + OTHER,
  ]) {
    assert.equal((await html(`/_nap/api/naps?${query}`, token, "x")).status, 400, query);
  }
  assert.equal(
    (await html(`/_nap/api/naps/${everyone.json.id}/versions?access=private`, token, "x")).status,
    400,
    "updates cannot change access",
  );
  assert.equal(await visibilityOf(everyone.json.id), "everyone");

  // Direct uploads: presigned URLs, then a commit that checks the files in R2. Their own token,
  // so the upload rate limit does not reach the checks below.
  const directToken = await signIn(OWNER, "Direct uploads");
  const directHtml = "<title>Big report</title><img src=img/chart.png>";
  const directPng = "x".repeat(2048);
  const putLocal = (url, body) =>
    nap.put(decodeURIComponent(new URL(url).pathname.replace(/^\/nap-sites-local\//, "")), body);
  const started = await postJson(
    "/_nap/api/uploads",
    {
      files: [
        { path: "index.html", size: Buffer.byteLength(directHtml) },
        { path: "img/chart.png", size: directPng.length, type: "image/png" },
      ],
      access: "everyone",
    },
    bearer(directToken),
  );
  assert.equal(started.status, 201, started.text);
  const direct = started.json;
  assert.match(direct.commitUrl, /\/_nap\/api\/uploads\/[0-9a-f-]{36}\/commit$/);
  assert.equal(direct.files.length, 2);
  for (const file of direct.files) {
    const signed = new URL(file.url);
    assert.equal(signed.host, "test-account.r2.cloudflarestorage.com");
    assert.match(
      signed.pathname,
      new RegExp(`^/nap-sites-local/sites/${direct.id}/versions/[0-9a-f-]{36}/${file.path}$`),
    );
    assert.equal(
      signed.searchParams.get("X-Amz-SignedHeaders"),
      "content-length;content-type;host",
    );
    assert.equal(signed.searchParams.get("X-Amz-Expires"), "3600");
  }
  assert.equal(direct.files[1].headers["content-type"], "image/png");
  const commitPath = new URL(direct.commitUrl).pathname;
  const early = await postJson(commitPath, {}, bearer(directToken));
  assert.equal(early.status, 409, early.text);
  assert.equal(early.json.code, "files_missing");
  assert.deepEqual(early.json.missing.sort(), ["img/chart.png", "index.html"]);
  await putLocal(direct.files[0].url, directHtml);
  await putLocal(direct.files[1].url, directPng.slice(1));
  assert.deepEqual(
    (await postJson(commitPath, {}, bearer(directToken))).json.missing,
    ["img/chart.png"],
    "commit checks sizes",
  );
  await putLocal(direct.files[1].url, directPng);
  const otherToken = await signIn(OTHER, "Other agent");
  assert.equal((await postJson(commitPath, {}, bearer(otherToken))).status, 404, "owner only");
  const committed = await postJson(commitPath, {}, bearer(directToken));
  assert.equal(committed.status, 201, committed.text);
  assert.equal(committed.json.id, direct.id);
  assert.equal(committed.json.title, "Big report", "title from <title>");
  assert.equal(committed.json.access, "everyone");
  assert.equal(await visibilityOf(direct.id), "everyone");
  const chart = await call(`/_nap/api/naps/${direct.id}/files/img/chart.png`, {
    headers: bearer(directToken),
  });
  assert.equal(chart.text, directPng);
  assert.equal((await postJson(commitPath, {}, bearer(directToken))).status, 409, "commit once");

  // Native apps reach a nap's collections and channels with a token instead of Access.
  const tokenData = await postJson(
    `/_nap/api/naps/${direct.id}/data/scores`,
    { team: "Blue", points: 3 },
    bearer(otherToken),
  );
  assert.equal(tokenData.status, 201, tokenData.text);
  const tokenList = await call(`/_nap/api/naps/${direct.id}/data/scores`, {
    headers: bearer(directToken),
  });
  assert.equal(tokenList.status, 200, tokenList.text);
  assert.match(tokenList.text, /"team":"Blue"/);
  assert.equal(
    (await call(`/_nap/api/naps/${direct.id}/data/scores`)).status,
    401,
    "data needs a token",
  );
  const welcome = await new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://localhost:${PORT}/_nap/api/naps/${direct.id}/channel/lobby`,
      { headers: bearer(otherToken) },
    );
    const timer = setTimeout(() => reject(new Error("No channel message")), 10_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(event.data));
    });
    socket.addEventListener("error", (event) =>
      reject(new Error(`Channel error: ${event.message}`)),
    );
  });
  assert.equal(welcome.t, "welcome", "the channel speaks to a token");
  // A watcher sees who is on a channel without being one of them.
  {
    const open = (path, token) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://localhost:${PORT}${path}`, { headers: bearer(token) });
        const inbox = [];
        const waiters = [];
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          const waiter = waiters.findIndex((w) => w.test(message));
          if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(message);
          else inbox.push(message);
        });
        socket.addEventListener("open", () => resolve({ socket, inbox, next }));
        socket.addEventListener("error", (event) => reject(new Error(`Channel: ${event.message}`)));
        function next(test, label) {
          const known = inbox.findIndex(test);
          if (known >= 0) return Promise.resolve(inbox.splice(known, 1)[0]);
          return new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error(`No ${label}`)), 10_000);
            waiters.push({ test, resolve: (m) => (clearTimeout(timer), done(m)) });
          });
        }
      });
    const base = `/_nap/api/naps/${direct.id}/channel/watched`;
    const player = await open(base, otherToken);
    await player.next((m) => m.t === "welcome", "player welcome");
    player.socket.send(JSON.stringify({ t: "presence", state: { ready: true } }));
    const watcher = await open(`${base}?watch=1`, directToken);
    const seen = await watcher.next((m) => m.t === "welcome", "watcher welcome");
    assert.equal(seen.peers.length, 1, "the watcher sees the player and not itself");
    assert.deepEqual(seen.peers[0].state, { ready: true }, "with the player's presence");
    const second = await open(base, directToken);
    const joined = await watcher.next((m) => m.t === "join", "join seen by the watcher");
    assert.ok(joined.peer.id, "the join names the new player");
    const secondWelcome = await second.next((m) => m.t === "welcome", "second welcome");
    assert.equal(secondWelcome.peers.length, 2, "players do not see the watcher");
    second.socket.send(JSON.stringify({ t: "send", data: "hi" }));
    await player.next((m) => m.t === "message", "message to the player");
    watcher.socket.send(JSON.stringify({ t: "send", data: "sneaky" }));
    const refused = await watcher.next((m) => m.t === "error", "watcher refused");
    assert.match(refused.error, /cannot send/);
    assert.ok(!watcher.inbox.some((m) => m.t === "message"), "watchers get no messages");
    assert.ok(
      !player.inbox.some((m) => m.t === "join" && m.peer.id === seen.id),
      "no join for the watcher",
    );
    for (const s of [player, watcher, second]) s.socket.close();
  }
  // ICE servers for voice: STUN at least, and TURN credentials when the stage has a TURN key.
  const rtc = await call(`/_nap/api/naps/${direct.id}/rtc`, { headers: bearer(otherToken) });
  assert.equal(rtc.status, 200, rtc.text);
  assert.ok(rtc.json.iceServers.length > 0, "rtc lists ICE servers");
  assert.equal(rtc.json.turn, Boolean(process.env.NAP_TURN_KEY_API_TOKEN), rtc.text);
  assert.equal(rtc.headers["cache-control"], "no-store");
  assert.equal((await call(`/_nap/api/naps/${direct.id}/rtc`)).status, 401, "rtc needs a token");

  // A direct upload of a new version keeps access; access on an update is an error.
  const directUpdate = await postJson(
    "/_nap/api/uploads",
    { id: direct.id, files: [{ path: "page.html", size: 3 }], message: "Smaller" },
    bearer(directToken),
  );
  assert.equal(directUpdate.status, 201, directUpdate.text);
  assert.equal(directUpdate.json.files[0].path, "index.html", "a single HTML file is index.html");
  await putLocal(directUpdate.json.files[0].url, "<p>");
  const updated = await postJson(
    new URL(directUpdate.json.commitUrl).pathname,
    {},
    bearer(directToken),
  );
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.json.created, false);
  assert.equal(updated.json.previousVersion, committed.json.version);
  assert.equal(await visibilityOf(direct.id), "everyone");
  for (const [body, status, why] of [
    [
      { id: direct.id, files: [{ path: "index.html", size: 1 }], access: "private" },
      400,
      "access on update",
    ],
    [
      {
        files: [
          { path: "index.html", size: 1 },
          { path: "a.bin", size: 4 * 1024 ** 3 },
          { path: "b.bin", size: 4 * 1024 ** 3 },
          { path: "c.bin", size: 4 * 1024 ** 3 },
        ],
      },
      413,
      "over 10 GB",
    ],
    [
      {
        files: [
          { path: "index.html", size: 1 },
          { path: "big.bin", size: 4 * 1024 ** 3 + 1 },
        ],
      },
      413,
      "one file over 4 GB",
    ],
    [{ files: [{ path: "app.js", size: 1 }] }, 400, "needs index.html"],
    [
      {
        files: [
          { path: "index.html", size: 1 },
          { path: "../app.js", size: 1 },
        ],
      },
      400,
      "unsafe path",
    ],
    [{ files: [{ path: "index.html", size: -1 }] }, 400, "bad size"],
    [{ id: everyone.json.id, files: [{ path: "index.html", size: 1 }] }, 201, "own nap"],
  ]) {
    assert.equal(
      (await postJson("/_nap/api/uploads", body, bearer(directToken))).status,
      status,
      why,
    );
  }
  // Anyone who can view a nap can update it. On someone else's nap, an agent must name the live
  // version it read.
  const blind = await postJson(
    "/_nap/api/uploads",
    { id: direct.id, files: [{ path: "index.html", size: 1 }] },
    bearer(otherToken),
  );
  assert.equal(blind.status, 409, blind.text);
  assert.equal(blind.json.code, "expected_version_required");
  assert.equal(
    (
      await postJson(
        "/_nap/api/uploads",
        {
          id: direct.id,
          expectedVersion: updated.json.version,
          files: [{ path: "index.html", size: 1 }],
        },
        bearer(otherToken),
      )
    ).status,
    201,
    "others update after reading it",
  );
  // Many files: the URLs come a page at a time, from nextPage.
  {
    const count = 1_201;
    const manyFiles = [
      { path: "index.html", size: 4 },
      ...Array.from({ length: count - 1 }, (_, i) => ({ path: `tiles/${i}.txt`, size: 1 })),
    ];
    const many = await postJson("/_nap/api/uploads", { files: manyFiles }, bearer(directToken));
    assert.equal(many.status, 201, many.text);
    assert.equal(many.json.fileCount, count);
    assert.equal(many.json.files.length, 1000);
    assert.match(many.json.next, /nextPage/);
    const signed = [...many.json.files];
    let nextPage = many.json.nextPage;
    assert.match(nextPage, /\/_nap\/api\/uploads\/[0-9a-f-]{36}\/urls\?offset=1000$/);
    assert.equal((await call(new URL(nextPage).pathname + "?offset=1000")).status, 401);
    while (nextPage) {
      const { pathname, search } = new URL(nextPage);
      const page = await call(pathname + search, { headers: bearer(directToken) });
      assert.equal(page.status, 200, page.text);
      signed.push(...page.json.files);
      nextPage = page.json.nextPage;
    }
    assert.equal(signed.length, count);
    for (const file of signed) await putLocal(file.url, file.path === "index.html" ? "<h1>" : "x");
    const manyCommit = await postJson(
      new URL(many.json.commitUrl).pathname,
      {},
      bearer(directToken),
    );
    assert.equal(manyCommit.status, 201, manyCommit.text);
    const tile = await call(`/_nap/api/naps/${manyCommit.json.id}/files/tiles/1199.txt`, {
      headers: bearer(directToken),
    });
    assert.equal(tile.text, "x", "a file from the last page is live");
    const removed = await call(`/api/sites/${manyCommit.json.id}`, {
      method: "DELETE",
      headers: as(OWNER),
    });
    assert.equal(removed.status, 200, removed.text);
  }
  // Dashboard direct uploads use the same flow behind Access. An agent cannot commit them.
  const dashboardStart = await postJson(
    "/api/uploads",
    { kind: "artifact", files: [{ path: "index.html", size: 4, type: "text/html" }] },
    as(OWNER),
  );
  assert.equal(dashboardStart.status, 201, dashboardStart.text);
  await putLocal(dashboardStart.json.files[0].url, "<h1>");
  const dashboardUploadId = dashboardStart.json.uploadId;
  assert.equal(
    (await postJson(`/_nap/api/uploads/${dashboardUploadId}/commit`, {}, bearer(directToken)))
      .status,
    404,
    "agents cannot commit dashboard uploads",
  );
  const dashboardCommit = await call(`/api/uploads/${dashboardUploadId}/commit`, {
    method: "POST",
    headers: as(OWNER),
  });
  assert.equal(dashboardCommit.status, 200, dashboardCommit.text);
  assert.equal(dashboardCommit.json.site.kind, "artifact");
  const dashboardSlug = dashboardCommit.json.site.slug;
  assert.equal(
    (
      await call(`/api/uploads/${dashboardUploadId}/commit`, {
        method: "POST",
        headers: { ...as(OWNER), "sec-fetch-site": "cross-site" },
      })
    ).status,
    403,
  );

  // Expired uploads lose their files when the next upload starts. Live versions stay.
  const abandoned = await postJson(
    "/_nap/api/uploads",
    { id: direct.id, files: [{ path: "index.html", size: 5 }] },
    bearer(directToken),
  );
  await putLocal(abandoned.json.files[0].url, "<old>");
  const abandonedKey = decodeURIComponent(
    new URL(abandoned.json.files[0].url).pathname.replace(/^\/nap-sites-local\//, ""),
  );
  await nap.sql(
    "UPDATE uploads SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    abandoned.json.uploadId,
  );
  assert.equal(await nap.has(abandonedKey), true);
  await postJson(
    "/_nap/api/uploads",
    { files: [{ path: "index.html", size: 1 }] },
    bearer(directToken),
  );
  assert.equal(await nap.has(abandonedKey), false, "expired upload files are deleted");
  assert.equal(
    (
      await call(`/_nap/api/naps/${direct.id}/files/index.html`, {
        headers: bearer(directToken),
      })
    ).text,
    "<p>",
    "the live version stays",
  );
  assert.equal(
    (await postJson(new URL(abandoned.json.commitUrl).pathname, {}, bearer(directToken))).status,
    404,
    "an expired upload is gone",
  );

  const directTokenId = (await call("/api/tokens", { headers: as(OWNER) })).json.tokens.find(
    (item) => item.clientName === "Direct uploads",
  ).id;
  await call(`/api/tokens/${directTokenId}`, { method: "DELETE", headers: as(OWNER) });
  assert.match((await call("/_nap/api/publish.mjs")).text, /node publish\.mjs login/);

  // Update, with a message.
  const update = await html(
    `/_nap/api/naps/${id}/versions?message=${encodeURIComponent("Fix the chart")}`,
    token,
    "<h1>v2</h1>",
  );
  assert.equal(update.status, 200, update.text);
  assert.equal(update.json.created, false);
  assert.equal(update.json.previousVersion, v1);
  const v2 = update.json.version;
  assert.equal(
    (await html(`/_nap/api/naps/${id}/versions?expectedVersion=${v1}`, token, "x")).status,
    409,
    "expectedVersion guards against lost updates",
  );

  // Multipart, with more than one file.
  const form = new FormData();
  form.append("files", new Blob(["<h1>v3</h1>"], { type: "text/html" }), "index.html");
  form.append("files", new Blob(["body{}"], { type: "text/css" }), "assets/app.css");
  form.append("message", "Add styles");
  const multipart = await fetch(`http://127.0.0.1:${PORT}/_nap/api/naps/${id}/versions`, {
    method: "POST",
    headers: bearer(token),
    body: form,
  });
  assert.equal(multipart.status, 200, await multipart.clone().text());
  const v3 = (await multipart.json()).version;

  const history = await call(`/_nap/api/naps/${id}/versions`, { headers: bearer(token) });
  assert.equal(history.status, 200, history.text);
  const versions = history.json.versions;
  assert.deepEqual(
    versions.map((version) => version.id),
    [v3, v2, v1],
    "newest first",
  );
  assert.equal(versions[0].live, true);
  assert.equal(versions[0].source, "agent");
  assert.equal(versions[0].client, "Pi on test-mbp");
  assert.equal(versions[0].message, "Add styles");
  assert.equal(versions[0].parentVersionId, v2);
  assert.equal(versions[2].parentVersionId, null);
  assert.deepEqual(
    versions.map((version) => version.number),
    [3, 2, 1],
    "numbered from the first upload",
  );

  // Read the source back, so a new session can edit it.
  const files = await call(`/_nap/api/naps/${id}/files`, { headers: bearer(token) });
  assert.deepEqual(files.json.files.map((file) => file.path).sort(), [
    "assets/app.css",
    "index.html",
  ]);
  const css = await call(`/_nap/api/naps/${id}/files/assets/app.css`, {
    headers: bearer(token),
  });
  assert.equal(css.text, "body{}");
  assert.equal(css.headers["content-security-policy"], "sandbox");
  const old = await call(`/_nap/api/naps/${id}/files/index.html?version=${v1}`, {
    headers: bearer(token),
  });
  assert.equal(old.text, "<h1>v1</h1>");

  // Restore moves the live version. Nothing is copied.
  const restored = await postJson(`/_nap/api/naps/${id}/restore`, { version: v1 }, bearer(token));
  assert.equal(restored.status, 200, restored.text);
  const viewer = await call(`/artifact/${id}`, { headers: as(OWNER) });
  const frameSrc = viewer.text.match(/data-src="([^"]+)"/)?.[1];
  assert.ok(frameSrc, viewer.text);
  const served = await call(frameSrc);
  assert.match(served.text, /^<script>.*<\/script><h1>v1<\/h1>$/s, "the restored version is live");

  // The history button in the Nap bar: versions, previews, and restore.
  const barHistory = await call(`/artifact/${id}/_nap/versions`, { headers: as(OWNER) });
  assert.equal(barHistory.status, 200, barHistory.text);
  assert.equal(barHistory.json.versions.find((version) => version.live).number, 1);
  assert.equal(
    (await call(`/artifact/${id}/_nap/versions`, { headers: as(OTHER) })).status,
    404,
    "only people who can view it see the history",
  );
  const framePrefix = frameSrc.match(/^\/_nap\/frame\/[^/]+/)[0];
  const preview = await call(`${framePrefix}/_nap/version/${v2}/`);
  assert.equal(preview.status, 200, preview.text);
  assert.match(preview.text, /<h1>v2<\/h1>$/, "previews show the earlier version");
  assert.ok(
    preview.text.includes(`${framePrefix}/_nap/version/${v2}`),
    "preview pages resolve root paths below the version",
  );
  assert.equal(
    (await call(`${framePrefix}/_nap/version/00000000-0000-0000-0000-000000000000/`)).status,
    404,
  );
  assert.equal(
    (
      await postJson(
        `/artifact/${id}/_nap/versions`,
        { version: v2, expectedCurrentVersion: v1 },
        { ...as(OWNER), "sec-fetch-site": "cross-site" },
      )
    ).status,
    403,
  );
  const barRestore = await postJson(
    `/artifact/${id}/_nap/versions`,
    { version: v2, expectedCurrentVersion: v1 },
    as(OWNER),
  );
  assert.equal(barRestore.status, 200, barRestore.text);
  assert.match((await call(frameSrc)).text, /<h1>v2<\/h1>$/, "the frame follows the live version");

  // Dashboard history: people who can view it. Restore back to v3 from the dashboard.
  const dashboardHistory = await call(`/api/sites/${id}/versions`, { headers: as(OWNER) });
  assert.equal(dashboardHistory.json.versions.find((version) => version.live).id, v2);
  assert.equal((await call(`/api/sites/${id}/versions`, { headers: as(OTHER) })).status, 404);
  assert.equal(
    (await postJson(`/api/sites/${id}/versions`, { version: v3 }, as(OTHER))).status,
    404,
    "only people who can view it restore",
  );
  assert.equal(
    (
      await postJson(
        `/api/sites/${id}/versions`,
        { version: v3, expectedCurrentVersion: v1 },
        as(OWNER),
      )
    ).status,
    409,
    "restore checks the live version",
  );
  assert.equal(
    (await postJson(`/api/sites/${id}/versions`, { version: v3 }, as(OWNER))).status,
    200,
  );

  // Comments: people who can view an artifact comment from the Nap bar. The owner's agent reads,
  // replies, and resolves.
  const comments = `/artifact/${id}/_nap/comments`;
  const patchJson = (path, value, headers = {}) =>
    call(path, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(value),
    });
  const ask = { body: "Make the heading bigger", path: "/", quote: "v3", prefix: "", suffix: "" };
  assert.equal((await postJson(comments, ask, as(OTHER))).status, 404, "only viewers comment");
  assert.equal(
    (
      await patchJson(
        `/artifact/${id}/_nap/access`,
        { visibility: "selected", emails: [OTHER] },
        as(OWNER),
      )
    ).status,
    200,
  );
  assert.equal(
    (await postJson(comments, ask, { ...as(OTHER), "sec-fetch-site": "cross-site" })).status,
    403,
    "other origins cannot comment",
  );
  const asked = await postJson(comments, ask, as(OTHER));
  assert.equal(asked.status, 201, asked.text);
  const thread = asked.json.comment;
  assert.equal(thread.version, v3, "a comment records the live version");
  assert.equal(thread.author.email, OTHER);
  const agentComments = `/_nap/api/naps/${id}/comments`;
  const open = await call(`${agentComments}?status=open`, { headers: bearer(token) });
  assert.equal(open.status, 200, open.text);
  assert.deepEqual(
    open.json.comments.map((item) => [item.id, item.quote, item.body]),
    [[thread.id, "v3", "Make the heading bigger"]],
  );
  const replied = await postJson(
    `${agentComments}/${thread.id}/replies`,
    { body: "Done in the next version" },
    bearer(token),
  );
  assert.equal(replied.status, 201, replied.text);
  assert.equal(replied.json.comment.replies[0].client, "Pi on test-mbp", "agent replies say so");
  assert.equal(
    (await patchJson(`${agentComments}/${thread.id}`, { resolved: true }, bearer(token))).json
      .comment.resolvedBy,
    OWNER,
  );
  assert.equal(
    (await call(`${agentComments}?status=open`, { headers: bearer(token) })).json.comments.length,
    0,
  );
  const seen = (await call(comments, { headers: as(OTHER) })).json.comments;
  assert.equal(seen[0].resolved, true, "viewers see the agent's reply and resolve");
  assert.equal(seen[0].replies[0].body, "Done in the next version");
  assert.equal(
    (await patchJson(`${comments}/${thread.id}`, { resolved: false }, as(OTHER))).json.comment
      .resolved,
    false,
    "viewers reopen",
  );
  const pageComment = await postJson(agentComments, { body: "Whole page" }, bearer(token));
  assert.equal(pageComment.json.comment.quote, "", "a comment without a quote is on the page");
  assert.equal(
    (await call("/_nap/api/naps/agent-site/comments", { headers: bearer(token) })).status,
    404,
    "only artifacts have comments",
  );

  // Dashboard uploads record their source too.
  const upload = new FormData();
  upload.append("files", new Blob(["<h1>other</h1>"], { type: "text/html" }), "index.html");
  const otherUpload = await fetch(`http://127.0.0.1:${PORT}/api/upload`, {
    method: "POST",
    headers: as(OTHER),
    body: upload,
  });
  assert.equal(otherUpload.status, 200, await otherUpload.clone().text());
  const otherSlug = (await otherUpload.json()).site.slug;
  const otherHistory = await call(`/api/sites/${otherSlug}/versions`, { headers: as(OTHER) });
  assert.equal(otherHistory.json.versions[0].source, "dashboard");
  const madePrivate = await patchJson(
    `/api/sites/${otherSlug}/access`,
    { visibility: "private", emails: [] },
    as(OTHER),
  );
  assert.equal(madePrivate.status, 200, madePrivate.text);

  // A token only sees and changes naps its person can view.
  assert.equal((await call(`/_nap/api/naps/${otherSlug}`, { headers: bearer(token) })).status, 404);
  assert.equal(
    (await html(`/_nap/api/naps/${otherSlug}/versions`, token, "<h1>x</h1>")).status,
    404,
  );
  assert.equal(
    (await postJson(`/_nap/api/naps/${otherSlug}/comments`, { body: "x" }, bearer(token))).status,
    404,
  );
  const list = await call("/_nap/api/naps", { headers: bearer(token) });
  assert.deepEqual(
    list.json.naps.map((nap) => nap.id).sort(),
    ["agent-site", id, everyone.json.id, invited.json.id, direct.id, dashboardSlug].sort(),
  );

  // Shared editing: `id` is shared with OTHER now. They see its history and update it, but only
  // the owner changes who can view it.
  assert.equal((await call(`/api/sites/${id}/versions`, { headers: as(OTHER) })).status, 200);
  const otherList = (await call("/_nap/api/naps", { headers: bearer(otherToken) })).json.naps;
  const sharedNap = otherList.find((nap) => nap.id === id);
  assert.equal(sharedNap?.role, "editor", "naps shared with me are listed");
  assert.equal(sharedNap.owner, OWNER);
  const blindVersion = await html(`/_nap/api/naps/${id}/versions`, otherToken, "<h1>v4</h1>");
  assert.equal(blindVersion.status, 409, blindVersion.text);
  assert.equal(blindVersion.json.code, "expected_version_required");
  const readFirst = await call(`/_nap/api/naps/${id}`, { headers: bearer(otherToken) });
  const v4 = await html(
    `/_nap/api/naps/${id}/versions?expectedVersion=${readFirst.json.nap.currentVersion}&title=Renamed`,
    otherToken,
    "<h1>v4</h1>",
  );
  assert.equal(v4.status, 200, v4.text);
  assert.equal(v4.json.title, readFirst.json.nap.title, "only the owner renames");
  assert.equal(
    (await html(`/_nap/api/naps/${id}/versions?access=everyone`, otherToken, "x")).status,
    400,
    "agents never change access on an update",
  );
  const blindRestore = await postJson(
    `/_nap/api/naps/${id}/restore`,
    { version: v1 },
    bearer(otherToken),
  );
  assert.equal(blindRestore.status, 409, blindRestore.text);
  const restoredByOther = await postJson(
    `/_nap/api/naps/${id}/restore`,
    { version: v1, expectedCurrentVersion: v4.json.version },
    bearer(otherToken),
  );
  assert.equal(restoredByOther.status, 200, restoredByOther.text);
  const historyByOther = await call(`/_nap/api/naps/${id}/versions`, {
    headers: bearer(otherToken),
  });
  assert.equal(historyByOther.json.versions[0].uploadedByEmail, OTHER);

  // Dashboard uploads check that the person can view the nap, and come from Nap itself.
  const dashboardForm = () => {
    const form = new FormData();
    form.append("files", new Blob(["<h1>x</h1>"], { type: "text/html" }), "index.html");
    form.append("targetSlug", otherSlug);
    return form;
  };
  const intoPrivate = await fetch(`http://127.0.0.1:${PORT}/api/upload`, {
    method: "POST",
    headers: as(OWNER),
    body: dashboardForm(),
  });
  assert.equal(intoPrivate.status, 404, "no uploads into a nap you cannot view");
  const crossSite = await fetch(`http://127.0.0.1:${PORT}/api/upload`, {
    method: "POST",
    headers: { ...as(OTHER), "sec-fetch-site": "cross-site" },
    body: dashboardForm(),
  });
  assert.equal(crossSite.status, 403, "other origins cannot upload");

  // Transfer: owner only, to someone who has used Nap. A private nap becomes shared with the
  // previous owner, so they keep access.
  const transfer = (slug, email, by) =>
    call(`/api/sites/${slug}/owner`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(by) },
      body: JSON.stringify({ email }),
    });
  assert.equal((await transfer(otherSlug, OWNER, OWNER)).status, 403, "only the owner transfers");
  assert.equal((await transfer(otherSlug, "nobody@example.com", OTHER)).status, 400);
  const transferred = await transfer(otherSlug, OWNER.toUpperCase(), OTHER);
  assert.equal(transferred.status, 200, transferred.text);
  assert.equal(transferred.json.visibility, "selected");
  const afterTransfer = (await call("/api/sites", { headers: as(OWNER) })).json.sites.find(
    (item) => item.slug === otherSlug,
  );
  assert.equal(afterTransfer.createdByEmail, OWNER);
  assert.deepEqual(afterTransfer.viewerEmails, [OTHER], "the previous owner keeps access");
  assert.equal(
    (await transfer(otherSlug, OTHER, OTHER)).status,
    403,
    "the previous owner cannot take it back",
  );

  // Paused when the owner has not used Nap for 30 days. Back when they open Nap.
  await nap.sql(
    "UPDATE profiles SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE email = ?",
    OWNER,
  );

  const paused = await call("/_nap/api/me", { headers: bearer(token) });
  assert.equal(paused.status, 401, paused.text);
  assert.equal(paused.json.code, "inactive");
  await call("/api/me", { headers: as(OWNER) });
  assert.equal((await call("/_nap/api/me", { headers: bearer(token) })).status, 200);

  // Connected agents: list and revoke.
  const tokens = await call("/api/tokens", { headers: as(OWNER) });
  assert.equal(tokens.json.tokens.length, 1);
  const tokenId = tokens.json.tokens[0].id;
  assert.equal(tokens.json.tokens[0].clientName, "Pi on test-mbp");
  assert.equal(
    (await call(`/api/tokens/${tokenId}`, { method: "DELETE", headers: as(OTHER) })).status,
    404,
    "only the owner revokes",
  );
  assert.equal(
    (await call(`/api/tokens/${tokenId}`, { method: "DELETE", headers: as(OWNER) })).status,
    200,
  );
  assert.equal((await call("/_nap/api/me", { headers: bearer(token) })).status, 401);

  // A second sign-in works after a revoke.
  const second = await signIn(OWNER, "Codex");
  assert.equal((await call("/_nap/api/me", { headers: bearer(second) })).json.client, "Codex");

  console.log(
    "Agent API HTTP checks passed: sign-in, tokens, publish, versions, restore, and comments.",
  );
} finally {
  await nap?.stop();
}
// The runtime's platform proxy leaves a local server open after dispose().
process.exit(0);
