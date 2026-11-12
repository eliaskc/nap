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

async function uploadDraft(query, html) {
  const res = await call(`/_nap/drafts${query}`, {
    method: "POST",
    headers: { "content-type": "text/html" },
    body: html,
  });
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

  // A draft without a slug is an artifact: a random id, private, unlisted, with the toolbar.
  const first = await uploadDraft("?title=Report", "<h1>v1</h1>");
  assert.equal(first.kind, "artifact", "no slug means artifact");
  const preview = await call(`/api/drafts/${first.id}/preview/`, { headers: as(OWNER) });
  assert.match(preview.headers["content-security-policy"], /sandbox/, "preview is sandboxed");

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
    (await call(`/api/drafts/${third.id}`, { headers: as(STRANGER) })).json.suggestedSite,
    null,
    "people who cannot view it learn nothing about the artifact",
  );
  assert.equal(
    (await claim(third.id, { replace: true, slug: artifact.slug }, STRANGER)).status,
    403,
    "only people who can view it can update",
  );
  const asInvitee = (await call(`/api/drafts/${third.id}`, { headers: as(OTHER) })).json
    .suggestedSite;
  assert.equal(asInvitee.canUpdate, true, "invited people can update");
  assert.equal(asInvitee.isOwner, false);
  assert.equal(asInvitee.viewerEmails, undefined, "only the owner sees who is invited");
  const updated = await claim(third.id, {
    replace: true,
    slug: artifact.slug,
    expectedCurrentVersion: described.json.suggestedSite.currentVersion,
  });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.json.site.visibility, "selected", "an update keeps access");

  // An invited person publishes a new version, but cannot change its access or name.
  const fourth = await uploadDraft(`?replaces=${third.id}`, "<h1>v4</h1>");
  const byInvitee = await claim(
    fourth.id,
    { replace: true, slug: artifact.slug, title: "Renamed", visibility: "everyone" },
    OTHER,
  );
  assert.equal(byInvitee.status, 200, byInvitee.text);
  assert.equal(byInvitee.json.site.visibility, "selected", "access stays the owner's choice");
  assert.equal(byInvitee.json.site.title, "Report", "the name stays the owner's choice");

  // Artifacts live at <root>/artifact/<slug>: the Nap bar with a sandboxed frame. The frame loads
  // its files from /_nap/frame/<token>/, which needs no Access cookie.
  const contentHost = `${artifact.slug}.${ROOT}`;
  const artifactPath = `/artifact/${artifact.slug}`;
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
  const rootedPage = await viewer(OWNER, `/artifact/${rootedSite.slug}`);
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

  // Move it to Sites. It moves to its own host, and the artifact URL redirects there. Now invited
  // people and, once listed, everyone see it.
  assert.equal((await settings({ kind: "site" })).json.kind, "site");
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

  // A slug makes a site. Reserved slugs are refused.
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
  assert.equal(unnamed.json.site.title, "Untitled site");
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
  assert.match((await siteFetch("https://example.com/")).json.error, /not in this site/);
  assert.equal((await siteFetch("http://api.example.com/")).status, 403, "https only");
  assert.equal((await siteFetch(`https://x.${ROOT}/`)).status, 403, "never Nap's own hosts");
  assert.equal((await siteFetch("https://api.example.com/", OTHER)).status, 403, "viewers only");
  assert.equal(
    (await siteFetch("https://api.example.com/", OWNER, { "sec-fetch-site": "cross-site" })).status,
    403,
    "same-site pages only",
  );
  assert.equal((await siteFetch("not a url")).status, 400);

  // A site that moves to Artifacts gets a random id. Its slug only redirects.
  const toArtifact = await call("/api/sites/team-map/settings", {
    method: "PATCH",
    ...jsonBody({ kind: "artifact" }),
    headers: { "content-type": "application/json", ...as(OWNER) },
  });
  assert.equal(toArtifact.status, 200, toArtifact.text);
  const mapId = toArtifact.json.slug;
  assert.match(mapId, /^[a-z0-9]{12}$/, "a random id");
  assert.equal(toArtifact.json.kind, "artifact");
  const fromSiteHost = await call("/notes/?x=1", {
    host: `team-map.${ROOT}`,
    headers: signedIn(OWNER),
  });
  assert.equal(fromSiteHost.status, 302);
  assert.equal(fromSiteHost.headers.location, `https://${ROOT}/artifact/${mapId}/notes/?x=1`);
  const oldPath = await viewer(OWNER, "/artifact/team-map");
  assert.equal(oldPath.status, 302);
  assert.equal(oldPath.headers.location, `/artifact/${mapId}`);
  const mapPage = await viewer(OWNER, `/artifact/${mapId}`);
  assert.equal(mapPage.status, 200, mapPage.text);
  const ownSlugs = (await call("/api/sites", { headers: as(OWNER) })).json.sites.map((s) => s.slug);
  assert.ok(ownSlugs.includes(mapId) && !ownSlugs.includes("team-map"), "the slug is not shown");
  const renameArtifact = await call(`/api/sites/${mapId}`, {
    method: "PATCH",
    ...jsonBody({ title: "Team map", slug: "team-map-2" }),
    headers: { "content-type": "application/json", ...as(OWNER) },
  });
  assert.equal(renameArtifact.status, 400, "an artifact's id cannot be renamed");
  // Back to Sites: it keeps its id as its host. The old slug still finds it.
  await call(`/api/sites/${mapId}/settings`, {
    method: "PATCH",
    ...jsonBody({ kind: "site" }),
    headers: { "content-type": "application/json", ...as(OWNER) },
  });
  const viaOldSlug = await viewer(OWNER, "/artifact/team-map");
  assert.equal(viaOldSlug.headers.location, `/artifact/${mapId}`);
  const deleted = await call(`/api/sites/${mapId}`, { method: "DELETE", headers: as(OWNER) });
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(
    (await call("/", { host: `team-map.${ROOT}`, headers: signedIn(OWNER) })).status,
    404,
    "deleting a nap removes its redirects",
  );

  console.log(
    "Agent publish HTTP checks passed: drafts, claims, replaces, sites, artifacts, and hosts.",
  );
} finally {
  await nap?.stop();
}
// The runtime's platform proxy leaves a local server open after dispose().
process.exit(0);
