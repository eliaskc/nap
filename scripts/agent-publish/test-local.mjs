// Checks agent drafts, claims, sites, artifacts, and host routing against Nap on a new local
// Alchemy stage with its own D1/R2 store. Never touches production.
import { request as httpRequest } from "node:http";
import { napConfig } from "../../nap.config.ts";
import assert from "node:assert/strict";
import { startLocalNap } from "../lib/local-nap.mjs";

const PORT = 8799;
const ROOT = napConfig.rootDomain;
const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const STRANGER = "stranger@example.com";

/** node:http, because fetch() does not let us set the Host header. */
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
 */
async function call(path, options = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await send(path, options);
    if (attempt < 3 && res.status === 503 && res.text.includes("restarted mid-request")) continue;
    return res;
  }
}

const as = (email) => ({ "x-nap-dev-email": email });
const signedIn = (email) => ({ "cf-access-authenticated-user-email": email, ...as(email) });
const jsonBody = (value) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

const tokens = {};

/** Signs in as `email` through the device flow and returns the agent token. */
async function signIn(email) {
  const post = (path, value, headers = {}) =>
    call(path, {
      method: "POST",
      ...jsonBody(value),
      headers: { ...jsonBody(value).headers, ...headers },
    });
  const start = await post("/_nap/api/auth/device", { client: `Test agent for ${email}` });
  assert.equal(start.status, 200, start.text);
  const approved = await post(
    `/api/connect/${start.json.user_code}`,
    { action: "approve" },
    as(email),
  );
  assert.equal(approved.status, 200, approved.text);
  const exchanged = await post("/_nap/api/auth/token", { device_code: start.json.device_code });
  assert.equal(exchanged.status, 200, exchanged.text);
  return exchanged.json.token;
}

function postDraft(query, html, token) {
  return call(`/_nap/api/drafts${query}`, {
    method: "POST",
    headers: { "content-type": "text/html", ...(token && { authorization: `Bearer ${token}` }) },
    body: html,
  });
}

async function uploadDraft(query, html, email = OWNER) {
  const res = await postDraft(query, html, tokens[email]);
  assert.equal(res.status, 201, `draft upload ${query}: ${res.text}`);
  return res.json;
}

async function claim(id, value, email = OWNER) {
  const res = await call(`/api/drafts/${id}`, {
    method: "POST",
    ...jsonBody(value),
    headers: { "content-type": "application/json", ...as(email) },
  });
  return res;
}

let nap;
try {
  nap = await startLocalNap({ port: PORT, label: "publish" });
  for (const email of [OWNER, OTHER, STRANGER]) tokens[email] = await signIn(email);

  // Drafts need a token. The old upload path without one is gone.
  assert.equal((await postDraft("", "<h1>x</h1>")).status, 401, "no token, no draft");
  const tokenless = await call("/_nap/drafts", {
    method: "POST",
    headers: { "content-type": "text/html" },
    body: "<h1>x</h1>",
  });
  assert.equal(tokenless.status, 410, tokenless.text);
  assert.match(tokenless.json.error, /_nap\/api\/drafts/);

  // A draft is a nap in Nap's frame: a random id, private, unlisted, with the Nap bar.
  const first = await uploadDraft("?title=Report", "<h1>v1</h1>");
  assert.equal(first.kind, "artifact", "in the frame by default");
  assert.equal(first.ownHost, false);
  const preview = await call(`/api/drafts/${first.id}/preview/`, { headers: as(OWNER) });
  assert.match(preview.headers["content-security-policy"], /sandbox/, "preview is sandboxed");
  // Only the uploader sees or publishes a draft, so a claim link sent to someone else does nothing.
  assert.equal(
    (await call(`/api/drafts/${first.id}/preview/`, { headers: as(OTHER) })).status,
    404,
    "only the uploader sees the preview",
  );
  assert.equal(
    (await call(`/api/drafts/${first.id}`, { headers: as(OTHER) })).status,
    403,
    "only the uploader opens the claim link",
  );
  assert.equal((await claim(first.id, {}, OTHER)).status, 403, "only the uploader publishes");

  const published = await claim(first.id, { visibility: "selected", emails: [OTHER] });
  assert.equal(published.status, 200, published.text);
  const artifact = published.json.site;
  assert.equal(artifact.kind, "artifact");
  assert.match(artifact.slug, /^[a-z0-9]{12}$/, "a random id, not the title");
  assert.equal(artifact.title, "Report");
  assert.equal((await claim(first.id, {})).status, 409, "a claim link works once");

  const listed = async (email) =>
    (await call("/api/sites", { headers: as(email) })).json.sites.find(
      (site) => site.slug === artifact.slug,
    );
  const own = await listed(OWNER);
  assert.equal(own.kind, "artifact");
  assert.equal(own.listed, false, "new artifacts are unlisted");
  assert.equal(own.toolbar, true, "new naps have the toolbar");
  assert.deepEqual(own.viewerEmails, [OTHER], "the owner sees who is invited");

  // Updates through replaces=<claim id>, also through a chain of drafts.
  const second = await uploadDraft(`?replaces=${first.id}`, "<h1>v2</h1>");
  const third = await uploadDraft(`?replaces=${second.id}`, "<h1>v3</h1>");
  const described = await call(`/api/drafts/${third.id}`, { headers: as(OWNER) });
  assert.equal(described.json.suggestedSite.slug, artifact.slug, "replaces chain resolves");
  assert.equal(
    (await call(`/api/drafts/${second.id}`, { headers: as(OWNER) })).json.draft.supersededBy,
    third.id,
    "older draft points at the newer one",
  );
  assert.equal(
    (await postDraft(`?replaces=${third.id}`, "<h1>x</h1>", tokens[OTHER])).status,
    404,
    "replaces only takes your own drafts",
  );
  // Someone who cannot view it gets nothing from their own draft either.
  const byStranger = await uploadDraft("", "<h1>stranger</h1>", STRANGER);
  assert.equal(
    (await claim(byStranger.id, { replace: true, slug: artifact.slug }, STRANGER)).status,
    403,
    "only people who can view it can update",
  );
  const updated = await claim(third.id, {
    replace: true,
    slug: artifact.slug,
    expectedCurrentVersion: described.json.suggestedSite.currentVersion,
  });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.json.site.visibility, "selected", "an update keeps access");

  // An invited person publishes a new version from their own draft, but cannot change its access
  // or name.
  const fourth = await uploadDraft("", "<h1>v4</h1>", OTHER);
  const asInvitee = (await call(`/api/drafts/${fourth.id}`, { headers: as(OTHER) })).json;
  assert.equal(asInvitee.suggestedSite, null, "a draft without replaces suggests nothing");
  const byInvitee = await claim(
    fourth.id,
    { replace: true, slug: artifact.slug, title: "Renamed", visibility: "everyone" },
    OTHER,
  );
  assert.equal(byInvitee.status, 200, byInvitee.text);
  assert.equal(byInvitee.json.site.visibility, "selected", "access stays the owner's choice");
  assert.equal(byInvitee.json.site.title, "Report", "the name stays the owner's choice");

  // Artifacts live at <root>/<slug>: the Nap bar with a sandboxed frame. The frame loads its
  // files from /_nap/frame/<token>/, which needs no Access cookie.
  const contentHost = `${artifact.slug}.${ROOT}`;
  const artifactPath = `/${artifact.slug}`;
  const viewer = (email, path = artifactPath) =>
    call(path, { host: ROOT, headers: { ...signedIn(email), "sec-fetch-dest": "document" } });
  // People without a name go to the welcome page first.
  for (const email of [OWNER, OTHER, "x@example.com"]) {
    await call("/api/me", { host: ROOT, method: "GET", headers: signedIn(email) });
    const named = await call("/api/me", {
      host: ROOT,
      method: "PATCH",
      headers: { ...signedIn(email), "content-type": "application/json" },
      body: JSON.stringify({ displayName: email.split("@")[0] }),
    });
    assert.equal(named.status, 200, named.text);
  }
  const page = await viewer(OWNER);
  assert.equal(page.status, 200, page.text);
  const frameSrc = page.text.match(/data-src="(\/_nap\/frame\/[A-Za-z0-9_-]+)\/"/)?.[1];
  assert.ok(frameSrc, "the viewer frames a frame-token path");
  assert.match(page.text, /sandbox="allow-scripts[^"]*"/, "the frame is sandboxed");
  assert.doesNotMatch(page.text, /allow-same-origin/, "the frame has an opaque origin");
  assert.match(page.text, /_nap\/viewer\.js/);
  assert.match(page.text, /rel="icon"[^>]*favicon\.svg\?v=/, "the viewer has Nap's icon");
  assert.match(
    page.text,
    new RegExp(`comments\\.js" data-nap-comments="${artifactPath}/_nap/comments"`),
    "the bar loads comments",
  );
  assert.match(
    page.text,
    new RegExp(`share\\.js[^>]*data-access="${artifactPath}/_nap/access"`),
    "owner sees the share button",
  );
  const deep = await viewer(OWNER, `${artifactPath}/notes/a.html?x=1`);
  assert.match(deep.text, /data-src="\/_nap\/frame\/[A-Za-z0-9_-]+\/notes\/a\.html\?x=1"/);

  // Old links at /artifact/<slug> move to /<slug> for good, with their path and query.
  const legacy = await viewer(OWNER, `/artifact/${artifact.slug}/notes/a.html?x=1`);
  assert.equal(legacy.status, 301, legacy.text);
  assert.equal(legacy.headers.location, `${artifactPath}/notes/a.html?x=1`);
  const legacyPage = await viewer(OWNER, `/artifact/${artifact.slug}`);
  assert.equal(legacyPage.status, 301);
  assert.equal(legacyPage.headers.location, artifactPath);
  // Nap's own routes win over names, and a name that is no nap gets the dashboard's 404.
  const unknown = await viewer(OWNER, "/zz-no-such-nap");
  assert.equal(unknown.status, 404, "an unknown name is not found");
  assert.doesNotMatch(unknown.text, /data-nap-content/, "and gets no viewer");
  assert.equal((await viewer(OWNER, "/zz-no-such-nap/_nap/access")).status, 404);
  const connectPage = await viewer(OWNER, "/connect");
  assert.equal(connectPage.status, 200, "Nap's own pages still load");
  assert.doesNotMatch(connectPage.text, /data-nap-content/);

  // The frame needs only the token: no Access headers.
  const frame = (path, options = {}) => call(`${frameSrc}${path}`, { host: ROOT, ...options });
  const content = await frame("/");
  assert.equal(content.status, 200, content.text);
  assert.match(content.text, /v4/, "content is the new version");
  assert.match(content.text, /nap:location/, "the frame script is added");
  assert.match(content.text, /_nap\/comments-frame\.js/, "the comments script is added");
  assert.equal((await frame("/_nap/comments-frame.js")).status, 200, "it loads with the token");
  assert.match(content.headers["content-security-policy"], /^sandbox allow-scripts/);
  assert.match(
    content.headers["content-security-policy"],
    new RegExp(`frame-ancestors http://${ROOT.replaceAll(".", "\\.")}$`),
  );
  assert.equal(content.headers["access-control-allow-origin"], "*");
  assert.equal((await frame("")).status, 302, "the frame root needs a trailing slash");
  assert.equal(
    (await call(`/_nap/frame/${"x".repeat(43)}/`, { host: ROOT })).status,
    404,
    "unknown tokens get nothing",
  );
  assert.equal((await frame("/_nap/me")).json.email, OWNER, "the token says who is viewing");
  assert.equal((await frame("/_nap/client.js")).status, 200);
  const preflight = await frame("/_nap/data/notes", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  const note = await frame("/_nap/data/notes", { method: "POST", ...jsonBody({ text: "hi" }) });
  assert.equal(note.status, 201, note.text);
  assert.equal(note.json.document.createdBy, OWNER, "data is written as the viewer");
  // Live updates through the frame token. WebSocket clients cannot set Host, so upgrade by hand.
  const upgradeStatus = (path) =>
    new Promise((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: PORT,
        path: `${frameSrc}${path}`,
        headers: {
          host: ROOT,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": Buffer.from("nap-live-test-key").toString("base64"),
        },
        agent: false,
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      });
      req.on("response", (res) => resolve(res.statusCode));
      req.setTimeout(10_000, () => req.destroy(new Error("Live upgrade timed out")));
      req.on("error", reject);
      req.end();
    });
  assert.equal(await upgradeStatus("/_nap/live"), 101, "artifact frames get live updates");
  assert.equal(await upgradeStatus("/_nap/channel/lobby"), 101, "artifact frames get channels");

  // The viewer keeps its token alive through the Access-protected artifact page.
  const token = frameSrc.split("/").pop();
  // A bar opened before the move renews through the old path: 308 keeps the POST.
  const oldRenew = await call(`/artifact/${artifact.slug}/_nap/frame`, {
    host: ROOT,
    method: "POST",
    headers: { ...signedIn(OWNER), "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(oldRenew.status, 308);
  assert.equal(oldRenew.headers.location, `${artifactPath}/_nap/frame`);
  const renew = (email, body = { token }) =>
    call(`${artifactPath}/_nap/frame`, {
      host: ROOT,
      method: "POST",
      headers: { ...signedIn(email), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const renewed = await renew(OWNER);
  assert.equal(renewed.status, 200, renewed.text);
  assert.equal(renewed.json.renewed, true);
  assert.equal((await renew(OTHER)).status, 404, "only the token's own viewer renews it");
  assert.equal((await renew(OWNER, { token: "x".repeat(43) })).status, 404);

  const asOther = await viewer(OTHER);
  assert.equal(asOther.status, 200, "invited people can open it");
  assert.doesNotMatch(asOther.text, /share\.js/, "viewers do not get the share button");
  assert.equal((await viewer("x@example.com")).status, 403, "others are blocked");

  // The artifact's old host and the old artifacts host redirect to the artifact page.
  const oldHost = await call("/notes/?x=1", {
    host: contentHost,
    headers: { ...signedIn(OWNER), "sec-fetch-dest": "document" },
  });
  assert.equal(oldHost.status, 302);
  assert.equal(oldHost.headers.location, `https://${ROOT}${artifactPath}/notes/?x=1`);
  const old = await call(`/${artifact.slug}`, {
    host: `artifacts.${ROOT}`,
    headers: signedIn(OWNER),
  });
  assert.equal(old.status, 302);
  assert.equal(old.headers.location, `https://${ROOT}${artifactPath}`);

  // Root paths in HTML stay inside the frame.
  const rooted = await uploadDraft(
    "?title=Rooted",
    '<html><head><title>R</title></head><body><img src="/x.png"><a href="//example.com/">e</a></body></html>',
  );
  const rootedSite = (await claim(rooted.id, {})).json.site;
  const rootedPage = await viewer(OWNER, `/${rootedSite.slug}`);
  const rootedFrame = rootedPage.text.match(/data-src="(\/_nap\/frame\/[A-Za-z0-9_-]+)\/"/)[1];
  const rootedHtml = (await call(`${rootedFrame}/`, { host: ROOT })).text;
  assert.ok(rootedHtml.includes(`src="${rootedFrame}/x.png"`), rootedHtml);
  assert.ok(rootedHtml.includes('href="//example.com/"'), "other hosts are left alone");
  assert.match(rootedHtml, /^<html><script>/, "the frame script runs first");

  const accessPath = `${artifactPath}/_nap/access`;
  const accessInfo = await call(accessPath, { host: ROOT, headers: signedIn(OWNER) });
  assert.equal(accessInfo.json.canManage, true);
  assert.equal(accessInfo.json.me.email, OWNER, "owner gets share suggestions");
  assert.ok(Array.isArray(accessInfo.json.people));
  assert.equal(
    (await call(accessPath, { host: ROOT, headers: signedIn(OTHER) })).json.people,
    undefined,
    "viewers get no suggestions",
  );
  const shared = await call(accessPath, {
    method: "PATCH",
    host: ROOT,
    ...jsonBody({ visibility: "everyone", emails: [OTHER] }),
    headers: { "content-type": "application/json", ...signedIn(OWNER) },
  });
  assert.equal(shared.status, 200, "owner shares from the bar");
  assert.deepEqual(shared.json.viewerEmails, [OTHER], "invited people stay saved");
  assert.equal(
    (
      await call(accessPath, {
        method: "PATCH",
        host: ROOT,
        ...jsonBody({ visibility: "everyone" }),
        headers: { "content-type": "application/json", ...signedIn(OTHER) },
      })
    ).status,
    403,
    "only the owner changes access",
  );
  // Dashboard lists: invited people see other people's artifacts under Shared with me.
  assert.equal((await listed(OTHER))?.invited, true, "invited people see the artifact");
  const settings = (value, email = OWNER) =>
    call(`/api/sites/${artifact.slug}/settings`, {
      method: "PATCH",
      ...jsonBody(value),
      headers: { "content-type": "application/json", ...as(email) },
    });
  assert.equal((await settings({ listed: true }, OTHER)).status, 403, "only the owner lists it");
  const listing = await settings({ listed: true });
  assert.equal(listing.json?.listed, true, listing.text);
  assert.equal(await listed("x@example.com"), undefined, "a listed artifact stays off lists");

  // Move it to its own host, with the older kind field. It keeps its name, and <root>/<name>
  // redirects to the host. Now invited people and, once listed, everyone see it.
  const toHost = await settings({ kind: "site" });
  assert.equal(toHost.json.kind, "site");
  assert.equal(toHost.json.ownHost, true);
  assert.equal(toHost.json.slug, artifact.slug, "the name stays");
  const moved = await viewer(OWNER, `${artifactPath}/notes/`);
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.location, `https://${contentHost}/notes/`);
  assert.equal((await frame("/")).status, 404, "frame tokens stop at the move");
  const asInvited = await listed(OTHER);
  assert.equal(asInvited.invited, true, "shared with me");
  assert.deepEqual(asInvited.viewerEmails, [], "only the owner sees the invite list");
  assert.equal((await listed("x@example.com")).listed, true, "listed sites show for everyone");
  assert.equal(
    (await call(`/api/sites/${artifact.slug}`, { method: "DELETE", headers: as(OTHER) })).status,
    403,
    "only the owner deletes it",
  );

  // Sites with the toolbar: a top-level visit gets the toolbar page, which frames the same host.
  // Frame loads get the files.
  const sitePage = (email, dest) =>
    call("/", { host: contentHost, headers: { ...signedIn(email), "sec-fetch-dest": dest } });
  const toolbar = await sitePage(OWNER, "document");
  assert.equal(toolbar.status, 200, toolbar.text);
  assert.match(toolbar.text, /data-nap-content src="\/"/, "toolbar frames the same host");
  assert.match(toolbar.text, /_nap\/share\.js/, "owner sees the share button");
  assert.match(toolbar.headers.vary, /sec-fetch-dest/i);
  const siteContent = await sitePage(OWNER, "iframe");
  assert.match(siteContent.text, /v4/);
  assert.equal(siteContent.headers["content-security-policy"], "frame-ancestors 'self'");
  // Sites without their own /favicon.ico get Nap's.
  const favicon = await call("/favicon.ico", { host: contentHost, headers: signedIn(OWNER) });
  assert.equal(favicon.status, 200, "sites get Nap's favicon");
  assert.match(favicon.headers["content-type"], /icon/);

  // Toolbar off: top-level visits get the files directly.
  assert.equal((await settings({ toolbar: false })).json.toolbar, false);
  const bare = await sitePage(OWNER, "document");
  assert.match(bare.text, /v4/, "no toolbar page");
  assert.equal(bare.headers["content-security-policy"], undefined, "no frame limit");

  assert.equal((await call("/", { host: `a.b.${ROOT}`, headers: signedIn(OWNER) })).status, 404);

  // A slug alone still means its own host, as it always did. Reserved names are refused.
  const reserved = await uploadDraft("?slug=artifacts", "<h1>x</h1>");
  assert.equal(reserved.kind, "site");
  assert.equal((await claim(reserved.id, { title: "x", slug: "artifacts" })).status, 409);
  // A site can still be published without a chosen URL.
  const unnamed = await claim(reserved.id, {});
  assert.equal(
    unnamed.json.site?.visibility,
    napConfig.defaultAccess,
    "new naps get the default access",
  );
  assert.equal(unnamed.status, 200, unnamed.text);
  assert.equal(unnamed.json.site.kind, "site");
  assert.match(unnamed.json.site.slug, /^[a-z0-9]{6}$/, "no title: a short random id");
  assert.equal(unnamed.json.site.title, "Untitled nap");
  // A nap on its own host whose name Nap now uses for its own pages cannot move into the frame
  // until it is renamed.
  await nap.sql(
    `INSERT INTO sites (slug, kind, title, created_by_email, updated_by_email, current_version,
                        sort_order)
     VALUES ('install', 'site', 'Old', ?1, ?1, 'none', 0)`,
    OWNER,
  );
  const reservedMove = await call("/api/sites/install/settings", {
    method: "PATCH",
    ...jsonBody({ ownHost: false }),
    headers: { "content-type": "application/json", ...as(OWNER) },
  });
  assert.equal(reservedMove.status, 409, reservedMove.text);
  await nap.sql("DELETE FROM sites WHERE slug = 'install'");

  // A draft with a chosen name: a nap in the frame at <root>/<name>.
  const namedDraft = await uploadDraft("?name=quiz-board&title=Quiz", "<h1>quiz</h1>");
  assert.equal(namedDraft.kind, "artifact");
  assert.equal(namedDraft.ownHost, false);
  const namedClaim = await claim(namedDraft.id, { slug: "quiz-board" });
  assert.equal(namedClaim.status, 200, namedClaim.text);
  assert.equal(namedClaim.json.site.slug, "quiz-board");
  assert.equal(namedClaim.json.site.kind, "artifact");
  const namedPage = await viewer(OWNER, "/quiz-board");
  assert.equal(namedPage.status, 200, namedPage.text);
  assert.match(namedPage.text, /data-src="\/_nap\/frame\//, "served in the frame");
  assert.match(namedPage.text, /<header>/, "with the bar");
  // A later draft with the same name suggests an update of it.
  const namedAgain = await uploadDraft("?name=quiz-board", "<h1>quiz 2</h1>");
  const namedAgainInfo = await call(`/api/drafts/${namedAgain.id}`, { headers: as(OWNER) });
  assert.equal(namedAgainInfo.json.suggestedSite.slug, "quiz-board");
  assert.equal(namedAgainInfo.json.suggestedSite.canUpdate, true);
  assert.equal(
    (await claim(namedAgain.id, { slug: "quiz-board" })).status,
    409,
    "a new nap cannot take the name",
  );
  // The older kind=artifact with a slug is a chosen name too.
  const legacyNamed = await uploadDraft("?kind=artifact&slug=quiz-old", "<h1>q</h1>");
  assert.equal(legacyNamed.kind, "artifact");
  assert.equal((await claim(legacyNamed.id, { slug: "quiz-old" })).json.site.slug, "quiz-old");
  const site = await uploadDraft("?slug=team-map&title=Team%20map", "<h1>map</h1>");
  const siteClaim = await claim(site.id, {
    title: "Team map",
    slug: "team-map",
    visibility: "private",
  });
  assert.equal(siteClaim.status, 200, siteClaim.text);
  assert.equal(siteClaim.json.site.visibility, "private", "the claim sets the access");
  assert.equal(
    (await call("/", { host: `team-map.${ROOT}`, headers: signedIn(OTHER) })).status,
    403,
    "private site is closed to others",
  );
  const siteDocument = await call("/", {
    host: `team-map.${ROOT}`,
    headers: { ...signedIn(OWNER), "sec-fetch-dest": "document" },
  });
  assert.match(siteDocument.text, /map/, "new sites have no toolbar by default");
  // The local stand-in /s/<name>/ never serves a nap's code on the root host.
  assert.equal(
    (await call("/s/team-map/", { host: ROOT, headers: signedIn(OWNER) })).status,
    404,
    "/s/ is local only",
  );

  // nap.json: "spa" serves the root index.html for page paths without a file. Manifests are
  // cached per version, so this writes it before anything reads it.
  const teamMapPage = (path) => call(path, { host: `team-map.${ROOT}`, headers: signedIn(OWNER) });
  await nap.put(
    `sites/team-map/versions/${siteClaim.json.site.currentVersion}/nap.json`,
    JSON.stringify({ spa: true, fetch: ["api.example.com", `*.${ROOT}`] }),
  );
  const spaPage = await teamMapPage("/games/mini?date=2026-01-01");
  assert.equal(spaPage.status, 200, spaPage.text);
  assert.match(spaPage.text, /map/, "a page path gets index.html");
  assert.match((await teamMapPage("/games/mini/")).text, /map/, "with a slash too");
  assert.equal((await teamMapPage("/assets/missing.js")).status, 404, "files stay 404");

  // Fetches: only GET over https, to the hosts the live version's nap.json lists.
  const siteFetch = (target, email = OWNER, extra = {}) =>
    call(`/_nap/fetch?url=${encodeURIComponent(target)}`, {
      host: `team-map.${ROOT}`,
      headers: { ...signedIn(email), ...extra },
    });
  assert.equal((await siteFetch("https://example.com/")).status, 403, "unlisted host");
  assert.match((await siteFetch("https://example.com/")).json.error, /not in this nap/);
  assert.equal((await siteFetch("http://api.example.com/")).status, 403, "https only");
  assert.equal((await siteFetch(`https://x.${ROOT}/`)).status, 403, "never Nap's own hosts");
  assert.equal((await siteFetch("https://api.example.com/", OTHER)).status, 403, "viewers only");
  assert.equal(
    (await siteFetch("https://api.example.com/", OWNER, { "sec-fetch-site": "cross-site" })).status,
    403,
    "same-site pages only",
  );
  assert.equal((await siteFetch("not a url")).status, 400);

  // A nap on its own host moves into Nap's frame and keeps its name: team-map.<root> becomes
  // <root>/team-map, and the old host redirects there.
  const mapSettings = (slug, value) =>
    call(`/api/sites/${slug}/settings`, {
      method: "PATCH",
      ...jsonBody(value),
      headers: { "content-type": "application/json", ...as(OWNER) },
    });
  const toFrame = await mapSettings("team-map", { ownHost: false });
  assert.equal(toFrame.status, 200, toFrame.text);
  assert.equal(toFrame.json.slug, "team-map", "the name stays");
  assert.equal(toFrame.json.kind, "artifact");
  assert.equal(toFrame.json.ownHost, false);
  const fromSiteHost = await call("/notes/?x=1", {
    host: `team-map.${ROOT}`,
    headers: signedIn(OWNER),
  });
  assert.equal(fromSiteHost.status, 302);
  assert.equal(fromSiteHost.headers.location, `https://${ROOT}/team-map/notes/?x=1`);

  // It had no bar on its own host, and has none in the frame: only the frame, filling the
  // window, with no comments and no Share. The viewer script still renews the frame token.
  const barless = await viewer(OWNER, "/team-map");
  assert.equal(barless.status, 200, barless.text);
  assert.match(barless.text, /<iframe data-nap-content data-src="\/_nap\/frame\//);
  assert.match(barless.text, /sandbox="allow-scripts/, "still sandboxed");
  assert.match(barless.text, /_nap\/viewer\.js/, "the viewer script runs");
  assert.doesNotMatch(barless.text, /<header>/, "no bar");
  assert.doesNotMatch(barless.text, /comments\.js/, "no comments");
  assert.doesNotMatch(barless.text, /share\.js/, "no Share");
  const barlessToken = barless.text.match(/data-src="\/_nap\/frame\/([A-Za-z0-9_-]+)\//)[1];
  const barlessRenew = await call("/team-map/_nap/frame", {
    host: ROOT,
    method: "POST",
    headers: { ...signedIn(OWNER), "content-type": "application/json" },
    body: JSON.stringify({ token: barlessToken }),
  });
  assert.equal(barlessRenew.status, 200, barlessRenew.text);
  assert.match((await call(`/_nap/frame/${barlessToken}/`, { host: ROOT })).text, /map/);
  // The owner turns the bar on from the dashboard.
  assert.equal((await mapSettings("team-map", { toolbar: true })).json.toolbar, true);
  const withBar = await viewer(OWNER, "/team-map");
  assert.match(withBar.text, /<header>/, "the bar is back");
  assert.match(withBar.text, /comments\.js/);
  assert.match(withBar.text, /share\.js/);
  assert.equal((await mapSettings("team-map", { toolbar: false })).json.toolbar, false);

  // Renaming a nap in the frame: a chosen name, and the old one redirects.
  const rename = (slug, value) =>
    call(`/api/sites/${slug}`, {
      method: "PATCH",
      ...jsonBody({ title: "Team map", ...value }),
      headers: { "content-type": "application/json", ...as(OWNER) },
    });
  assert.equal((await rename("team-map", { slug: "connect" })).status, 409, "reserved");
  assert.equal((await rename("team-map", { slug: "quiz-board" })).status, 409, "taken");
  const renamed = await rename("team-map", { slug: "team-board" });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.json.site.slug, "team-board");
  const oldPath = await viewer(OWNER, "/team-map/notes/");
  assert.equal(oldPath.status, 302);
  assert.equal(oldPath.headers.location, "/team-board/notes/");
  assert.equal((await viewer(OWNER, "/team-board")).status, 200);
  // Back to a random id. Every old name follows it.
  const randomized = await rename("team-board", { randomName: true });
  assert.equal(randomized.status, 200, randomized.text);
  const mapId = randomized.json.site.slug;
  assert.match(mapId, /^[a-z0-9]{12}$/, "a random id");
  assert.equal((await viewer(OWNER, "/team-board")).headers.location, `/${mapId}`);
  assert.equal((await viewer(OWNER, "/team-map")).headers.location, `/${mapId}`);
  const mapPage = await viewer(OWNER, `/${mapId}`);
  assert.equal(mapPage.status, 200, mapPage.text);
  const ownSlugs = (await call("/api/sites", { headers: as(OWNER) })).json.sites.map((s) => s.slug);
  assert.ok(ownSlugs.includes(mapId) && !ownSlugs.includes("team-map"), "old names are not shown");

  // And back to its own host: it keeps its name, and <root>/<name> sends people there.
  const backToHost = await mapSettings(mapId, { ownHost: true });
  assert.equal(backToHost.json.slug, mapId);
  assert.equal(backToHost.json.kind, "site");
  const toOwnHost = await viewer(OWNER, `/${mapId}/notes/`);
  assert.equal(toOwnHost.status, 302);
  assert.equal(toOwnHost.headers.location, `https://${mapId}.${ROOT}/notes/`);
  const viaOldSlug = await viewer(OWNER, "/team-map");
  assert.equal(viaOldSlug.headers.location, `/${mapId}`);
  const viaOldLink = await viewer(OWNER, "/artifact/team-map");
  assert.equal(viaOldLink.headers.location, "/team-map", "old links take one more step");
  const deleted = await call(`/api/sites/${mapId}`, { method: "DELETE", headers: as(OWNER) });
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(
    (await call("/", { host: `team-map.${ROOT}`, headers: signedIn(OWNER) })).status,
    404,
    "deleting a nap removes its redirects",
  );

  // Dashboards: a draft with type=dashboard. Repeat opens of a dashboard are not counted as
  // visits; a page's are.
  assert.equal(
    (await postDraft("?type=slides", "<h1>x</h1>", tokens[OWNER])).status,
    400,
    "unknown types are refused",
  );
  const boardDraft = await uploadDraft("?type=dashboard&title=Signups", "<h1>board</h1>");
  assert.equal(boardDraft.type, "dashboard");
  const boardClaim = await claim(boardDraft.id, { visibility: "everyone" });
  assert.equal(boardClaim.status, 200, boardClaim.text);
  assert.equal(boardClaim.json.site.type, "dashboard");
  const board = boardClaim.json.site.slug;
  const plainClaim = await claim((await uploadDraft("?title=Plain", "<h1>plain</h1>")).id, {
    visibility: "everyone",
  });
  assert.equal(plainClaim.json.site.type, "page");
  const plain = plainClaim.json.site.slug;

  const sqlRows = async (query, ...params) => (await nap.sql(query, ...params)).results;
  // Visits are written after the response.
  const visitOf = async (slug, email, until = () => true) => {
    for (let attempt = 0; ; attempt++) {
      const [row] = await sqlRows(
        "SELECT visit_count AS count, visited_at AS at FROM site_visits WHERE site_slug = ? AND email = ?",
        slug,
        email,
      );
      if ((row && until(row)) || attempt === 50) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const OLD = "2000-01-01T00:00:00.000Z";
  const ageVisit = (slug, email) =>
    nap.sql(
      "UPDATE site_visits SET visited_at = ? WHERE site_slug = ? AND email = ?",
      OLD,
      slug,
      email,
    );
  /** Opens the nap, moves the visit back past the 30 minutes that count as one, opens it again. */
  const openTwice = async (slug, open = (path) => viewer(OTHER, path)) => {
    assert.equal((await open(`/${slug}`)).status, 200);
    assert.ok(await visitOf(slug, OTHER), "the first open is a visit");
    await ageVisit(slug, OTHER);
    assert.equal((await open(`/${slug}`)).status, 200);
    return visitOf(slug, OTHER, (row) => row.at !== OLD);
  };

  const pageVisit = await openTwice(plain);
  assert.equal(pageVisit.count, 2, "a page counts every visit");
  const boardVisit = await openTwice(board);
  assert.equal(boardVisit.count, 1, "a dashboard counts each person once");
  assert.notEqual(boardVisit.at, OLD, "but remembers when they last opened it");
  // It still shows as visited: in the owner's visitors and in the visitor's own list.
  const visitors = (await call(`/api/sites/${board}/visitors`, { headers: as(OWNER) })).json
    .visitors;
  assert.equal(visitors.find((visitor) => visitor.email === OTHER)?.visits, 1);
  const seen = (await call("/api/sites", { headers: as(OTHER) })).json.sites.find(
    (site) => site.slug === board,
  );
  assert.ok(seen?.visitedAt, "the dashboard is in the visitor's list as visited");

  // Changing the type keeps the counts already stored; the rule follows the type from then on.
  const typeSettings = (slug, value) =>
    call(`/api/sites/${slug}/settings`, {
      method: "PATCH",
      ...jsonBody(value),
      headers: { "content-type": "application/json", ...as(OWNER) },
    });
  assert.equal((await typeSettings(plain, { type: "dashboard" })).json.type, "dashboard");
  assert.equal((await visitOf(plain, OTHER)).count, 2, "stored counts stay");
  await ageVisit(plain, OTHER);
  await viewer(OTHER, `/${plain}`);
  assert.equal((await visitOf(plain, OTHER, (row) => row.at !== OLD)).count, 2);
  assert.equal((await typeSettings(board, { type: "page" })).json.type, "page");
  assert.equal((await openTwice(board)).count, 2, "a page again counts again");
  assert.equal(
    (await typeSettings(board, { type: "slides" })).status,
    400,
    "unknown types are refused",
  );

  // The same on a dashboard's own host.
  await typeSettings(board, { type: "dashboard" });
  assert.equal((await typeSettings(board, { ownHost: true })).status, 200);
  const onHost = (path) =>
    call(path.replace(`/${board}`, "/"), {
      host: `${board}.${ROOT}`,
      headers: { ...signedIn(OTHER), "sec-fetch-dest": "document" },
    });
  assert.equal((await openTwice(board, onHost)).count, 2, "counts stored before stay");
  await nap.sql("DELETE FROM site_visits WHERE site_slug = ?", board);
  assert.equal((await openTwice(board, onHost)).count, 1, "a dashboard on its own host too");

  // Loads (sites.view_count): every load of a nap's page by anyone, the owner and repeat opens
  // included, for every type, in the frame and on its own host. Not files, Nap's own routes,
  // token renewals, HEAD, or the access-denied page. Only the owner sees them, in Visitors.
  const loadsOf = async (slug, expected) => {
    // Loads are written after the response.
    for (let attempt = 0; ; attempt++) {
      const [row] = await sqlRows("SELECT view_count AS loads FROM sites WHERE slug = ?", slug);
      if (row.loads === expected || attempt === 50) return row.loads;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  const loadNaps = [];
  for (const type of ["page", "dashboard"]) {
    const draft = await uploadDraft(`?type=${type}&title=Loads`, "<h1>loads</h1>");
    const made = await claim(draft.id, { visibility: "everyone" });
    assert.equal(made.status, 200, made.text);
    const slug = made.json.site.slug;
    loadNaps.push(slug);
    await nap.put(`sites/${slug}/versions/${made.json.site.currentVersion}/app.js`, "1");
    await nap.sql("UPDATE sites SET view_count = 0 WHERE slug = ?", slug);

    // In the frame: the Nap page alone is not a load; the frame getting the page is.
    const open = async (email) => {
      const outer = await viewer(email, `/${slug}`);
      assert.equal(outer.status, 200, outer.text);
      const token = outer.text.match(/data-src="\/_nap\/frame\/([A-Za-z0-9_-]+)\//)[1];
      return {
        token,
        frame: (path, options = {}) =>
          call(`/_nap/frame/${token}${path}`, { host: ROOT, ...options }),
      };
    };
    const first = await open(OTHER);
    await settle();
    assert.equal(await loadsOf(slug, 0), 0, `${type}: the Nap page alone is not a load`);
    assert.match((await first.frame("/")).text, /loads/);
    assert.equal(await loadsOf(slug, 1), 1, `${type}: the frame's page is a load`);
    await first.frame("/");
    assert.equal(await loadsOf(slug, 2), 2, `${type}: the page reloading itself counts`);
    await (await open(OWNER)).frame("/");
    assert.equal(await loadsOf(slug, 3), 3, `${type}: the owner's loads count`);
    await (await open(OTHER)).frame("/");
    assert.equal(await loadsOf(slug, 4), 4, `${type}: repeat opens within 30 minutes count`);
    assert.equal((await first.frame("/app.js")).status, 200);
    assert.equal((await first.frame("/missing.js")).status, 404);
    assert.equal((await first.frame("/_nap/client.js")).status, 200);
    assert.equal((await first.frame("/_nap/me")).status, 200);
    assert.equal((await first.frame("/", { method: "HEAD" })).status, 200);
    const renewed = await call(`/${slug}/_nap/frame`, {
      host: ROOT,
      method: "POST",
      headers: { ...signedIn(OTHER), "content-type": "application/json" },
      body: JSON.stringify({ token: first.token }),
    });
    assert.equal(renewed.status, 200, renewed.text);
    await settle();
    assert.equal(await loadsOf(slug, 4), 4, `${type}: files, routes, and renewals are not loads`);

    // On its own host, with the bar: the bar page is not a load; its frame getting the page is.
    assert.equal((await typeSettings(slug, { ownHost: true, toolbar: true })).status, 200);
    const hosted = (email, path, dest) =>
      call(path, {
        host: `${slug}.${ROOT}`,
        headers: { ...signedIn(email), "sec-fetch-dest": dest },
      });
    assert.match((await hosted(OTHER, "/", "document")).text, /data-nap-content/);
    await settle();
    assert.equal(await loadsOf(slug, 4), 4, `${type}: the bar page is not a load`);
    assert.match((await hosted(OTHER, "/", "iframe")).text, /loads/);
    assert.equal(await loadsOf(slug, 5), 5, `${type}: a load on its own host`);
    await hosted(OTHER, "/", "iframe");
    assert.equal(await loadsOf(slug, 6), 6, `${type}: and again`);
    await hosted(OWNER, "/", "iframe");
    assert.equal(await loadsOf(slug, 7), 7, `${type}: the owner's too`);
    assert.equal((await hosted(OTHER, "/app.js", "script")).status, 200);
    // Nobody else may open it now: the access-denied page is not a load.
    await nap.sql("UPDATE sites SET visibility = 'private' WHERE slug = ?", slug);
    assert.equal((await hosted(OTHER, "/", "document")).status, 403);
    assert.equal((await hosted(OTHER, "/", "iframe")).status, 403);
    await settle();
    assert.equal(await loadsOf(slug, 7), 7, `${type}: assets and denied opens are not loads`);
    await nap.sql("UPDATE sites SET visibility = 'everyone' WHERE slug = ?", slug);

    // The owner sees the three numbers; views is the number the dashboard shows.
    const counted = await call(`/api/sites/${slug}/visitors`, { headers: as(OWNER) });
    assert.equal(counted.status, 200, counted.text);
    const shown = (await call("/api/sites", { headers: as(OWNER) })).json.sites.find(
      (site) => site.slug === slug,
    );
    assert.equal(counted.json.people, 1, `${type}: one person other than the owner`);
    assert.equal(counted.json.views, shown.viewCount, `${type}: the views the item shows`);
    assert.equal(counted.json.views, 1, `${type}: opens within 30 minutes are one view`);
    assert.equal(counted.json.loads, 7, `${type}: every load`);
    assert.equal("loads" in shown, false, "loads are not in the dashboard's list");
    const refused = await call(`/api/sites/${slug}/visitors`, { headers: as(OTHER) });
    assert.equal(refused.status, 403, "only the owner sees visitors and loads");
    assert.equal(refused.json.loads, undefined);
  }

  for (const slug of [board, plain, ...loadNaps]) {
    const removed = await call(`/api/sites/${slug}`, { method: "DELETE", headers: as(OWNER) });
    assert.equal(removed.status, 200, removed.text);
  }

  console.log(
    "Agent publish HTTP checks passed: drafts, claims, replaces, names, moves, the bar, hosts, and dashboards.",
  );
} finally {
  await nap?.stop();
}
// The runtime's platform proxy leaves a local server open after dispose().
process.exit(0);
