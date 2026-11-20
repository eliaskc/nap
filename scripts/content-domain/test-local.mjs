// Checks a Nap with a separate content domain against a new local Alchemy stage: naps on their
// own host served at <name>.<content> behind the content domain's Access application (a local
// stand-in for its signing keys), old <name>.<root> hosts that only redirect, naps in the frame
// unaffected, and content hosts that serve nothing but their one nap. Never touches production.
import { createServer, request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { napConfig } from "../../nap.config.ts";
import { startLocalNap } from "../lib/local-nap.mjs";

const PORT = 8795;
const ROOT = napConfig.rootDomain;
const CONTENT = "napcontent.test";
const AUD = "content-aud";
const OWNER = "owner@example.com";
const OTHER = "other@example.com";

/** node:http, because fetch() does not let us set the Host header. */
function send(path, { method = "GET", host = "localhost", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
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

/** The local dev proxy sometimes drops a request; the Worker never saw it, so send it again. */
async function call(path, options = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await send(path, options);
    if (attempt < 3 && res.status === 503 && res.text.includes("restarted mid-request")) continue;
    return res;
  }
}

/** A WebSocket handshake through the Host header. Resolves with the status it got. */
function upgrade(path, { host, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: PORT,
      path,
      headers: {
        host,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("nap-content-test!").toString("base64"),
        ...headers,
      },
      agent: false,
    });
    req.setTimeout(10_000, () => req.destroy(new Error(`Timeout: upgrade ${host}${path}`)));
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

const as = (email) => ({ "x-nap-dev-email": email });
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const postJson = (path, value, headers = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });

async function signIn(email) {
  const start = await postJson("/_nap/api/auth/device", { client: `Test agent for ${email}` });
  assert.equal(start.status, 200, start.text);
  const approved = await postJson(
    `/api/connect/${start.json.user_code}`,
    { action: "approve" },
    as(email),
  );
  assert.equal(approved.status, 200, approved.text);
  const exchanged = await postJson("/_nap/api/auth/token", { device_code: start.json.device_code });
  assert.equal(exchanged.status, 200, exchanged.text);
  return exchanged.json.token;
}

// A stand-in for the Access team: its signing keys, and the JWTs Access would add.
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "local", alg: "RS256" };
const keys = createServer((request, response) => {
  if (request.url !== "/cdn-cgi/access/certs") return response.writeHead(404).end();
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((resolve) => keys.listen(0, "127.0.0.1", resolve));
const ISSUER = `http://127.0.0.1:${keys.address().port}`;
const jwt = (email, aud = AUD) =>
  new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "local" })
    .setIssuer(ISSUER)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
/** What Access adds to a request on the content domain, for `email`. */
const contentSession = async (email) => ({
  "cf-access-authenticated-user-email": email,
  "cf-access-jwt-assertion": await jwt(email),
});
/** What Access adds on the root. The Worker reads the header there. */
const rootSession = (email) => ({ "cf-access-authenticated-user-email": email, ...as(email) });

let nap;
try {
  nap = await startLocalNap({
    port: PORT,
    label: "content",
    vars: {
      NAP_CONTENT_DOMAIN: CONTENT,
      NAP_ACCESS_ISSUER: ISSUER,
      NAP_CONTENT_ACCESS_AUD: AUD,
    },
  });
  const ownerToken = await signIn(OWNER);
  await signIn(OTHER);
  // Names, so the welcome page does not stand in front of page visits.
  for (const email of [OWNER, OTHER]) {
    await nap.sql(
      "UPDATE profiles SET display_name = ? WHERE email = ?",
      email.split("@")[0],
      email,
    );
  }

  // Publishing: the agent API names the content domain for naps on their own host.
  const page = `<!doctype html><title>Hosted</title><script src="/_nap/client.js"></script><h1>hosted</h1>`;
  const hosted = await call("/_nap/api/naps?name=hosted&ownHost=true&access=everyone", {
    method: "POST",
    host: ROOT,
    headers: { "content-type": "text/html", ...bearer(ownerToken) },
    body: page,
  });
  assert.equal(hosted.status, 201, hosted.text);
  assert.equal(hosted.json.url, `https://hosted.${CONTENT}/`);
  const framed = await call("/_nap/api/naps?name=framed&access=everyone", {
    method: "POST",
    host: ROOT,
    headers: { "content-type": "text/html", ...bearer(ownerToken) },
    body: "<title>Framed</title><h1>framed</h1>",
  });
  assert.equal(framed.status, 201, framed.text);
  assert.equal(framed.json.url, `https://${ROOT}/framed`);
  const listed = await call("/_nap/api/naps", { host: ROOT, headers: bearer(ownerToken) });
  assert.equal(listed.json.naps.find((n) => n.id === "hosted").url, `https://hosted.${CONTENT}/`);
  // The instructions show the content domain.
  const instructions = await call("/_nap/api/instructions", { host: ROOT });
  assert.ok(instructions.text.includes(`https://<name>.${CONTENT}`), "instructions");

  const hostedHost = `hosted.${CONTENT}`;
  const content = async (path, { email = OTHER, host = hostedHost, ...options } = {}) =>
    call(path, {
      host,
      ...options,
      headers: { ...(await contentSession(email)), ...options.headers },
    });

  // The nap on its content host: its page, window.nap, its data, and a channel socket.
  const home = await content("/", { headers: { "sec-fetch-dest": "document" } });
  assert.equal(home.status, 200, home.text);
  assert.match(home.text, /<h1>hosted<\/h1>/);
  assert.equal((await content("/_nap/client.js")).status, 200);
  const me = await content("/_nap/me");
  assert.equal(me.status, 200, me.text);
  assert.equal(me.json.email, OTHER, "the person from the content session");
  assert.equal((await content("/_nap/people")).status, 200);
  const written = await content("/_nap/data/scores", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ points: 3 }),
  });
  assert.equal(written.status, 201, written.text);
  const scores = await content("/_nap/data/scores");
  assert.equal(scores.status, 200, scores.text);
  assert.equal(scores.json.documents.length, 1);
  assert.equal(scores.json.documents[0].createdBy, OTHER);
  assert.equal((await content("/_nap/access")).status, 200, "the Share widget's access API");
  assert.equal(
    await upgrade("/_nap/channel/lobby", {
      host: hostedHost,
      headers: await contentSession(OTHER),
    }),
    101,
    "a channel socket",
  );
  assert.equal(
    await upgrade("/_nap/channel/lobby", { host: hostedHost, headers: rootSession(OTHER) }),
    403,
    "no socket without the content session",
  );
  const favicon = await content("/favicon.ico");
  assert.equal(favicon.status, 200, "Nap's favicon for naps without one");

  // Identity: only a JWT for the content application opens content hosts. A root session (the
  // header alone, or a JWT for another audience) and the local dev header do not.
  assert.equal((await call("/", { host: hostedHost, headers: rootSession(OTHER) })).status, 403);
  assert.equal((await call("/_nap/me", { host: hostedHost, headers: as(OTHER) })).status, 403);
  const rootJwt = {
    "cf-access-authenticated-user-email": OTHER,
    "cf-access-jwt-assertion": await jwt(OTHER, "root-aud"),
  };
  assert.equal((await call("/_nap/me", { host: hostedHost, headers: rootJwt })).status, 403);
  // The verified email wins over a header that says otherwise.
  const spoofed = await call("/_nap/me", {
    host: hostedHost,
    headers: { ...(await contentSession(OTHER)), "cf-access-authenticated-user-email": OWNER },
  });
  assert.equal(spoofed.json.email, OTHER);

  // Strict host dispatch: nothing but this nap on its host.
  for (const path of [
    "/api/me",
    "/api/sites",
    "/connect",
    "/welcome",
    "/claim/x",
    "/framed",
    "/s/framed/",
    "/_nap/api/naps",
    "/_nap/api/instructions",
    "/_nap/api/publish.mjs",
    "/_nap/drafts",
    `/_nap/frame/${"x".repeat(43)}/`,
    "/_nap/hooks/slack",
    // (/_nap/comments.js, a static script, is the dashboard's only: in production the Worker
    // runs first; in dev Vite serves it on every host.)
    "/_nap/unknown",
  ]) {
    const res = await content(path);
    assert.equal(
      res.status,
      404,
      `${path} on a content host: ${res.status} ${res.text.slice(0, 80)}`,
    );
  }
  const slack = await content("/_nap/hooks/slack", { method: "POST", body: "x" });
  assert.equal(slack.status, 404);
  const otherData = await content("/_nap/data/@framed/scores");
  assert.equal(otherData.status, 403, "another nap's data only when its nap.json allows it");

  // A nap in the frame, by name on the content domain: to <root>/<name>.
  const framedOnContent = await content("/notes?x=1", { host: `framed.${CONTENT}` });
  assert.equal(framedOnContent.status, 302);
  assert.equal(framedOnContent.headers.location, `https://${ROOT}/framed/notes?x=1`);
  // Unknown names: not found, and only for people with a content session.
  assert.equal((await content("/", { host: `nobody.${CONTENT}` })).status, 404);
  assert.equal((await call("/", { host: `nobody.${CONTENT}` })).status, 403);
  assert.equal((await content("/", { host: `a.b.${CONTENT}` })).status, 404);
  assert.equal((await call("/", { host: `a.b.${CONTENT}` })).status, 403);
  // The apex and www: to the dashboard.
  for (const host of [CONTENT, `www.${CONTENT}`]) {
    const apex = await content("/anything", { host });
    assert.equal(apex.status, 302, host);
    assert.equal(apex.headers.location, `https://${ROOT}/`);
    assert.equal((await call("/", { host })).status, 403, `${host} without a session`);
  }

  // The old host only redirects, with path and query, and serves nothing.
  const oldHost = `hosted.${ROOT}`;
  const old = await call("/games/a?x=1", { host: oldHost, headers: rootSession(OTHER) });
  assert.equal(old.status, 301);
  assert.equal(old.headers.location, `https://${hostedHost}/games/a?x=1`);
  const oldPost = await call("/_nap/data/scores", {
    method: "POST",
    host: oldHost,
    headers: { ...rootSession(OTHER), "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(oldPost.status, 308);
  assert.equal(oldPost.headers.location, `https://${hostedHost}/_nap/data/scores`);
  for (const path of ["/", "/_nap/client.js", "/_nap/me", "/_nap/data/scores", "/_nap/access"]) {
    const res = await call(path, { host: oldHost, headers: rootSession(OTHER) });
    assert.equal(res.status, 301, `${path} on the old host`);
  }
  assert.equal(
    await upgrade("/_nap/channel/lobby", { host: oldHost, headers: rootSession(OTHER) }),
    301,
    "no sockets on the old host",
  );
  const oldFramed = await call("/notes/?x=1", {
    host: `framed.${ROOT}`,
    headers: rootSession(OTHER),
  });
  assert.equal(oldFramed.status, 302);
  assert.equal(oldFramed.headers.location, `https://${ROOT}/framed/notes/?x=1`);
  assert.equal(
    (await call("/", { host: `nobody.${ROOT}`, headers: rootSession(OTHER) })).status,
    404,
  );

  // The root path of a nap on its own host goes to its content host.
  const fromRoot = await call("/hosted/notes?x=1", { host: ROOT, headers: rootSession(OTHER) });
  assert.equal(fromRoot.status, 302);
  assert.equal(fromRoot.headers.location, `https://${hostedHost}/notes?x=1`);
  // Its own-host files never run on the root, also not through the local /s/ stand-in.
  assert.equal((await call("/s/hosted/", { host: ROOT, headers: rootSession(OTHER) })).status, 404);

  // A nap in the frame works as before.
  const viewer = await call("/framed", {
    host: ROOT,
    headers: { ...rootSession(OTHER), "sec-fetch-dest": "document" },
  });
  assert.equal(viewer.status, 200, viewer.text);
  const frameSrc = viewer.text.match(/data-src="([^"]+)"/)?.[1];
  assert.ok(frameSrc, "the viewer frames the nap");
  const frame = await call(`${frameSrc}`, { host: ROOT });
  assert.equal(frame.status, 200);
  assert.match(frame.text, /framed/);

  // A rename keeps the old name working through both hosts.
  const renamed = await call("/api/sites/hosted", {
    method: "PATCH",
    host: ROOT,
    headers: { ...rootSession(OWNER), "content-type": "application/json" },
    body: JSON.stringify({ title: "Hosted", slug: "hosted-two" }),
  });
  assert.equal(renamed.status, 200, renamed.text);
  const oldName = await content("/x?y=1");
  assert.equal(oldName.status, 302);
  assert.equal(oldName.headers.location, `https://${ROOT}/hosted-two/x?y=1`);
  const oldNameOldHost = await call("/x?y=1", { host: oldHost, headers: rootSession(OTHER) });
  assert.equal(oldNameOldHost.status, 302);
  assert.equal(oldNameOldHost.headers.location, `https://hosted-two.${CONTENT}/x?y=1`);

  console.log("Content domain tests passed.");
} finally {
  keys.close();
  await nap?.stop();
}
