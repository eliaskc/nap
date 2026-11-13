import { meResponse, peopleResponse } from "~/lib/welcome";
import { Effect } from "effect";
import { handleSiteCommentsRequest } from "~/lib/comments";
import { ensureProfile, getIdentity, objectKey, type Identity } from "~/lib/nap-server";
import { toolbarPage } from "~/lib/nap-toolbar";
import { handleVisitorAccessRequest, visitorRequestState } from "~/lib/access-requests";
import { noAccessHeaders, noAccessPage } from "~/lib/no-access-page";
import { findRedirect } from "~/lib/rekey";
import { ARTIFACT_PATH, isLocalHostname, napUrl, type NapPlace } from "~/lib/nap-urls";
import { handleNotifyRequest } from "~/lib/notifications";
import { handleSiteAccessRequest } from "~/lib/site-access";
import { handleSiteDataRequest } from "~/lib/site-data";
import { handleSiteFilesRequest } from "~/lib/site-files";
import { serveSiteDataClient, serveVoiceEngine } from "~/lib/site-data-client";
import { handleLiveRequest, publishChange } from "~/lib/site-live";
import { handleChannelRequest } from "~/lib/site-channel";
import { handleRtcRequest } from "~/lib/site-rtc";
import { handleSiteFetch } from "~/lib/site-fetch";
import { EXTENSIONS } from "~/lib/extension-registry";
import { handleExtensionRequest } from "~/lib/extensions";
import { fileHeaders, findViewableNap, getNapFile, normalizeRequestPath } from "~/lib/site-serving";
import { serveShareWidget } from "~/lib/share-widget";
import { findVersion, listVersions, restoreVersion } from "~/lib/versions";
import { Database } from "~/server/database";
import {
  fail,
  failText,
  json,
  noStore,
  readJsonObject,
  recoverHttpError,
  redirect,
  requireJsonBody,
  requireSameSite,
} from "~/server/http";
import { inBackground, Settings } from "~/server/platform";
import { Storage } from "~/server/storage";
import { recordVisit } from "~/lib/visits";
import { randomString, sha256Hex } from "~/server/tokens";
import COMMENTS_FRAME_SOURCE from "virtual:nap-comments-frame";

/**
 * Artifacts live at <root>/artifact/<id>, like Claude's artifacts. The id is random. Old URLs
 * (nap_redirects) redirect to the current one.
 *
 * The page there is the Nap bar with a sandboxed iframe. The sandbox has no allow-same-origin, so
 * the artifact runs in an opaque origin: it cannot read the dashboard, other artifacts, or their
 * storage, even though they share a host.
 *
 * Requests from an opaque origin may not carry the Access cookie, so the frame does not use it.
 * Each page load makes a frame token, and the frame loads everything from
 * <root>/_nap/frame/<token>/: files, /_nap/client.js, /_nap/me, and /_nap/data. Access bypasses
 * that path. The Worker checks the token, and the person's access to the artifact, on every
 * request. The token is in the frame's URL only, never in the address bar.
 *
 * Paths:
 *   /artifact/<slug>[/<path>]           the page (Access)
 *   /artifact/<slug>/_nap/access        the share button's API (Access)
 *   /artifact/<slug>/_nap/comments      the comments API for the Nap bar (Access)
 *   /artifact/<slug>/_nap/versions      the history button's API (Access)
 *   /artifact/<slug>/_nap/frame         renews the frame token while the page is open (Access)
 *   /_nap/frame/<token>/<path>          the artifact's files (token)
 *   /_nap/frame/<token>/_nap/ext/<name>/<path>
 *                                       the deployment's extensions (token)
 *   /_nap/frame/<token>/_nap/version/<id>/<path>
 *                                       an earlier version's files, for the history preview
 */

export const FRAME_PREFIX = "/_nap/frame/";
const FRAME_TOKEN_HOURS = 12;
/** No allow-same-origin and no allow-top-navigation. */
export const FRAME_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

const ARTIFACT_ROUTE = new RegExp(`^${ARTIFACT_PATH}/([a-z0-9-]{1,32})(/.*)?$`);
const FRAME_ROUTE = /^\/_nap\/frame\/([A-Za-z0-9_-]{32,64})(\/.*)?$/;
const VERSION_ROUTE = /^\/_nap\/version\/([0-9a-f-]{36})(\/.*)?$/;

export function isArtifactPath(pathname: string) {
  return pathname === ARTIFACT_PATH || pathname.startsWith(`${ARTIFACT_PATH}/`);
}

export function isFramePath(pathname: string) {
  return pathname.startsWith(FRAME_PREFIX);
}

/** <root>/artifact/<slug>[/<path>]. Access protects this path. */
export const handleArtifactPage = Effect.fn("handleArtifactPage")(function* (
  request: Request,
  place: NapPlace,
) {
  const url = new URL(request.url);
  const match = url.pathname.match(ARTIFACT_ROUTE);
  if (!match) return statusPage(404, "Artifact not found", "The link is wrong.", place);
  const slug = match[1];
  const rest = match[2] ?? "";

  if (rest === "/_nap/access") return yield* handleSiteAccessRequest(slug, request);
  if (rest === "/_nap/access/request" || rest === "/_nap/access/status") {
    return yield* handleVisitorAccessRequest(
      slug,
      rest === "/_nap/access/request" ? "request" : "status",
      request,
      getIdentity(request),
      place,
    );
  }
  if (rest === "/_nap/comments" || rest.startsWith("/_nap/comments/")) {
    return yield* handleSiteCommentsRequest(slug, request, rest.slice("/_nap/comments".length));
  }
  if (rest === "/_nap/versions") return yield* handleArtifactVersionsRequest(slug, request);
  if (rest === "/_nap/frame") return yield* renewFrameToken(slug, request);
  if (rest.startsWith("/_nap/")) return yield* failText(404, "Not found");
  if (request.method !== "GET" && request.method !== "HEAD") {
    return yield* failText(405, "Method not allowed", { allow: "GET, HEAD" });
  }

  const identity = getIdentity(request);
  const access = yield* findViewableNap(slug, identity.email);
  if (access.status === "missing") {
    // An old URL of a nap that has a new key now, such as a site that moved to Artifacts.
    const moved = yield* findRedirect(slug);
    if (moved) return redirect(`${ARTIFACT_PATH}/${moved}${rest}${url.search}`);
    return statusPage(404, "Artifact not found", "The link is wrong, or it was deleted.", place);
  }
  // It moved to its own host. Old artifact links keep working.
  if (access.nap.kind === "site") {
    const target = napUrl(access.nap, place).replace(/\/$/, "");
    return redirect(`${target}${rest || "/"}${url.search}`);
  }
  if (access.status === "denied") {
    const { nap } = access;
    return new Response(
      noAccessPage({
        kind: "artifact",
        title: nap.title,
        visibility: nap.visibility,
        ownerName: nap.ownerName,
        ownerEmail: nap.createdByEmail,
        viewerEmail: identity.email,
        dashboardUrl: place.localOrigin ? "/" : `https://${place.rootDomain}/`,
        signOutUrl: place.localOrigin ? undefined : "/cdn-cgi/access/logout",
        request: yield* visitorRequestState(slug, identity.email),
        accessPath: `${ARTIFACT_PATH}/${slug}/_nap/access`,
        back: url.pathname + url.search,
      }),
      { status: 403, headers: noAccessHeaders },
    );
  }

  // The frame token is written with this person's email, which must have a profile.
  yield* ensureProfile(identity);
  yield* recordVisit(identity.email, slug);
  const token = randomString(32);
  const db = yield* Database;
  yield* db.run(
    `INSERT INTO artifact_frames (token_hash, site_slug, email, expires_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${FRAME_TOKEN_HOURS} hours'))`,
    yield* sha256Hex(token),
    slug,
    identity.email,
  );
  yield* inBackground(
    db
      .run("DELETE FROM artifact_frames WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
      .pipe(Effect.asVoid),
    "Artifact frame cleanup failed",
  );

  const { nap, isOwner } = access;
  return toolbarPage({
    title: nap.title,
    owner: nap.ownerName || nap.createdByEmail,
    updatedAt: nap.updatedAt,
    isOwner,
    frameSrc: `${FRAME_PREFIX}${token}${rest || "/"}${url.search}`,
    accessPath: `${ARTIFACT_PATH}/${slug}/_nap/access`,
    dashboardUrl: "/",
    artifact: {
      sandbox: FRAME_SANDBOX,
      base: `${ARTIFACT_PATH}/${slug}`,
      commentsPath: `${ARTIFACT_PATH}/${slug}/_nap/comments`,
      versionsPath: `${ARTIFACT_PATH}/${slug}/_nap/versions`,
    },
  });
});

/**
 * POST <root>/artifact/<slug>/_nap/frame with { token }: the viewer keeps its frame token alive.
 * Access protects this path, so only someone Access still lets in, who can still view the
 * artifact, extends their own token. 404 when it already ran out: the viewer reloads.
 */
const renewFrameToken = Effect.fn("renewFrameToken")(function* (slug: string, request: Request) {
  if (request.method !== "POST") {
    return yield* fail(405, "Method not allowed", {}, { allow: "POST" });
  }
  yield* requireSameSite(request);
  yield* requireJsonBody(request);
  const body = yield* readJsonObject(request);
  const token = typeof body.token === "string" ? body.token : "";
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return yield* fail(400, "Pass the frame token");
  const identity = getIdentity(request);
  const access = yield* findViewableNap(slug, identity.email);
  if (access.status !== "allowed") return yield* fail(404, "Artifact not found");
  const db = yield* Database;
  const { changes } = yield* db.run(
    `UPDATE artifact_frames
     SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${FRAME_TOKEN_HOURS} hours')
     WHERE token_hash = ? AND site_slug = ? AND lower(email) = lower(?)
       AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    yield* sha256Hex(token),
    slug,
    identity.email,
  );
  if (!changes) return yield* fail(404, "This artifact view has expired");
  return json({ renewed: true }, { headers: noStore });
});

/**
 * <root>/_nap/frame/<token>/<path>. Access bypasses this path: never use getIdentity() here.
 * Every response but a WebSocket's gets the CORS header, errors included.
 */
export const handleFrameRequest = Effect.fn("handleFrameRequest")(function* (request: Request) {
  const url = new URL(request.url);
  const match = url.pathname.match(FRAME_ROUTE);
  if (!match) return withCors(new Response("Not found", { status: 404 }));
  const token = match[1];
  let rest = match[2];
  let prefix = `${FRAME_PREFIX}${token}`;
  // An earlier version, for the history preview. Its pages get their files from below this
  // prefix, and use the same token for everything else (data, comments, the client).
  const versioned = rest?.match(VERSION_ROUTE);
  const previewVersion = versioned?.[1] ?? null;
  if (versioned) {
    prefix += `/_nap/version/${previewVersion}`;
    rest = versioned[2];
  }
  // Relative paths in the artifact need the trailing slash.
  if (!rest) return withCors(redirect(`${prefix}/${url.search}`));

  if (request.method === "OPTIONS") {
    return withCors(
      new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
          "access-control-allow-headers":
            "content-type, if-match, if-none-match, x-nap-fetch-headers, x-nap-file-name",
          "access-control-max-age": "600",
        },
      }),
    );
  }

  const db = yield* Database;
  const frame = yield* db.first<{
    slug: string;
    email: string;
    name: string | null;
    expiresAt: string;
  }>(
    `SELECT artifact_frames.site_slug AS slug, artifact_frames.email,
            profiles.display_name AS name, artifact_frames.expires_at AS expiresAt
     FROM artifact_frames LEFT JOIN profiles ON profiles.email = artifact_frames.email
     WHERE artifact_frames.token_hash = ?
       AND artifact_frames.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    yield* sha256Hex(token),
  );
  if (!frame) {
    return withCors(
      new Response("This artifact view has expired. Reload the page.", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      }),
    );
  }
  const identity: Identity = { email: frame.email, name: frame.name || frame.email };

  if (rest === "/_nap/client.js") return withCors(serveSiteDataClient());
  if (rest === "/_nap/client-voice.js") return serveVoiceEngine(request);
  // The share button shows nothing inside a frame. Serve it so pages that include it still load.
  if (rest === "/_nap/share.js") return withCors(serveShareWidget());
  // The comments script for inside the frame (src/comments/frame.ts), built into the Worker.
  if (rest === "/_nap/comments-frame.js") {
    return withCors(
      new Response(COMMENTS_FRAME_SOURCE, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff",
        },
      }),
    );
  }
  if (rest === "/_nap/me" && request.method === "GET") {
    return withCors(yield* meResponse(identity));
  }
  if (rest === "/_nap/people" && request.method === "GET") {
    return withCors(yield* peopleResponse(request));
  }
  if (rest.startsWith("/_nap/data/")) {
    const path = rest.slice("/_nap/data/".length);
    const slug = frame.slug;
    return withCors(
      yield* recoverHttpError(
        handleSiteDataRequest(slug, request, path, {
          frameIdentity: identity,
          onChange: (collection, change) => publishChange(slug, collection, change),
        }),
      ),
    );
  }
  if (rest === "/_nap/files" || rest.startsWith("/_nap/files/")) {
    return withCors(
      yield* recoverHttpError(
        handleSiteFilesRequest(frame.slug, request, rest.slice("/_nap/files".length), {
          identity,
        }),
      ),
    );
  }
  // A WebSocket response cannot get new headers, and WebSockets do not use CORS.
  // The socket closes when the frame token expires.
  if (rest === "/_nap/live") {
    return yield* handleLiveRequest(frame.slug, request, identity, frame.expiresAt);
  }
  if (rest.startsWith("/_nap/channel/")) {
    const name = rest.slice("/_nap/channel/".length);
    return yield* handleChannelRequest(frame.slug, name, request, identity, frame.expiresAt);
  }
  if (rest === "/_nap/rtc") {
    return withCors(yield* recoverHttpError(handleRtcRequest(frame.slug, request, identity)));
  }
  if (rest === "/_nap/fetch") {
    return withCors(
      yield* recoverHttpError(handleSiteFetch(frame.slug, request, frame.email, { frame: true })),
    );
  }
  if (rest === "/_nap/notify") {
    const { rootDomain } = yield* Settings;
    const local = isLocalHostname(url.hostname) ? url.origin : null;
    return withCors(
      yield* recoverHttpError(
        handleNotifyRequest(
          frame.slug,
          request,
          identity,
          { rootDomain, localOrigin: local },
          {
            frame: true,
          },
        ),
      ),
    );
  }
  if (rest.startsWith("/_nap/ext/")) {
    const path = rest.slice("/_nap/ext/".length);
    return withCors(
      yield* recoverHttpError(
        handleExtensionRequest(EXTENSIONS, frame.slug, request, identity, path, { frame: true }),
      ),
    );
  }
  if (rest.startsWith("/_nap/")) return withCors(new Response("Not found", { status: 404 }));

  if (request.method !== "GET" && request.method !== "HEAD") {
    return withCors(new Response("Method not allowed", { status: 405 }));
  }

  // Access can change while a page is open. Check it on every request.
  const access = yield* findViewableNap(frame.slug, frame.email);
  if (access.status !== "allowed" || access.nap.kind !== "artifact") {
    return withCors(new Response("Not found", { status: 404 }));
  }

  const normalizedPath = normalizeRequestPath(safeDecode(rest));
  let object: R2ObjectBody | null;
  if (previewVersion) {
    // Previews do not count as views.
    if (!(yield* findVersion(frame.slug, previewVersion))) {
      return withCors(new Response("Version not found", { status: 404 }));
    }
    const storage = yield* Storage;
    object = yield* storage.get(objectKey(frame.slug, previewVersion, normalizedPath));
  } else {
    object = yield* getNapFile(access.nap, normalizedPath);
  }
  if (!object) return withCors(new Response("File not found", { status: 404 }));

  const headers = fileHeaders(object);
  headers.set("x-content-type-options", "nosniff");
  // Opened outside the viewer, the file still gets an opaque origin.
  headers.set("content-security-policy", `sandbox ${FRAME_SANDBOX}; frame-ancestors ${url.origin}`);
  // Links to other sites must not carry the token.
  headers.set("referrer-policy", "same-origin");
  const response = withCors(new Response(object.body, { headers }));

  const contentType = headers.get("content-type") ?? "";
  if (!/^text\/html/i.test(contentType) || request.method === "HEAD") return response;
  if (!/charset=/i.test(contentType)) {
    response.headers.set("content-type", "text/html; charset=utf-8");
  }
  return rewriteArtifactHtml(response, prefix, url.origin);
});

/**
 * Root paths such as `/app.js` would leave the frame's folder. Point src, href, action, and poster
 * attributes below it. Script-built URLs are not changed: artifacts should use relative paths.
 * Adds the frame script (frameScript) and the comments script (src/comments/frame.ts) before
 * everything else in the page.
 */
function rewriteArtifactHtml(response: Response, prefix: string, viewerOrigin: string) {
  const script =
    `<script>${frameScript(prefix, viewerOrigin)}</script>` +
    `<script src="${prefix}/_nap/comments-frame.js" data-viewer="${viewerOrigin}" data-prefix="${prefix}" defer></script>`;
  let injected = false;
  const rootPath = (name: string) => ({
    element(element: Element) {
      const value = element.getAttribute(name);
      if (!value || !value.startsWith("/") || value.startsWith("//")) return;
      if (value === prefix || value.startsWith(`${prefix}/`)) return;
      element.setAttribute(name, prefix + value);
    },
  });
  return new HTMLRewriter()
    .on("*", {
      // The first element: inside <html>, <head>, or <body>, else before it (a fragment).
      element(element) {
        if (injected) return;
        injected = true;
        if (["html", "head", "body"].includes(element.tagName)) {
          element.prepend(script, { html: true });
        } else {
          element.before(script, { html: true });
        }
      },
    })
    .on("[src]", rootPath("src"))
    .on("[href]", rootPath("href"))
    .on("[action]", rootPath("action"))
    .on("[poster]", rootPath("poster"))
    .onDocument({
      end(end) {
        if (!injected) end.append(script, { html: true });
      },
    })
    .transform(response);
}

/**
 * Runs first in every artifact page:
 * - The opaque origin has no localStorage or sessionStorage, and touching them throws. Give the
 *   page in-memory stand-ins, so it works. Data does not last after a reload; artifacts that need
 *   that use window.nap.db.
 * - Tell the viewer the page's path, title, and icon links, so the address bar and the tab follow.
 */
function frameScript(prefix: string, viewerOrigin: string) {
  return `(function(){var P=${JSON.stringify(prefix)},O=${JSON.stringify(viewerOrigin)};
function mem(){var m=new Map();return{get length(){return m.size},key:function(i){var k=Array.from(m.keys())[i];return k===undefined?null:k},getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},setItem:function(k,v){m.set(String(k),String(v))},removeItem:function(k){m.delete(String(k))},clear:function(){m.clear()}}}
["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(e2){}}});
if(window.parent===window)return;
function post(){try{var p=location.pathname;if(p.indexOf(P)===0)p=p.slice(P.length)||"/";var icons=Array.prototype.map.call(document.querySelectorAll('link[rel~="icon"]'),function(l){return{href:l.href,type:l.type,sizes:l.getAttribute("sizes")||""}});parent.postMessage({type:"nap:location",path:p+location.search+location.hash,title:document.title,icons:icons},O)}catch(e){}}
["pushState","replaceState"].forEach(function(n){var o=history[n];history[n]=function(){var r=o.apply(this,arguments);post();return r}});
addEventListener("popstate",post);addEventListener("hashchange",post);
addEventListener("DOMContentLoaded",function(){post();var t=document.querySelector("title");if(t)new MutationObserver(post).observe(t,{childList:true,characterData:true,subtree:true})});
post();})();`;
}

/**
 * /artifact/<slug>/_nap/versions, for the history button in the Nap bar (Access).
 * GET lists the versions, newest first. POST { version, expectedCurrentVersion } makes one live.
 */
const handleArtifactVersionsRequest = Effect.fnUntraced(function* (slug: string, request: Request) {
  const identity = getIdentity(request);
  const access = yield* findViewableNap(slug, identity.email);
  if (access.status !== "allowed") return yield* fail(404, "Not found");

  if (request.method === "GET") {
    const db = yield* Database;
    const site = yield* db.first<{ hasSource: number }>(
      "SELECT source_repo IS NOT NULL AS hasSource FROM sites WHERE slug = ?",
      slug,
    );
    return json(
      { versions: yield* listVersions(slug), hasSource: Boolean(site?.hasSource) },
      { headers: noStore },
    );
  }
  if (request.method === "POST") {
    yield* requireSameSite(request);
    yield* requireJsonBody(request);
    yield* ensureProfile(identity);
    const body = yield* readJsonObject(request);
    return yield* restoreVersion(identity.email, slug, body);
  }
  return yield* fail(405, "Method not allowed");
});

function withCors(response: Response) {
  // The frame's origin is opaque ("null"), so its own fetches and module scripts are
  // cross-origin. The token in the path is the credential, not a cookie.
  const result = new Response(response.body, response);
  result.headers.set("access-control-allow-origin", "*");
  // nap.fetch tells Nap's own errors from the upstream's by these.
  result.headers.set("access-control-expose-headers", "x-nap-fetch, x-nap-fetch-url");
  return result;
}

function safeDecode(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function statusPage(status: number, title: string, message: string, place: NapPlace) {
  const dashboard = place.localOrigin ? "/" : `https://${place.rootDomain}/`;
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text(title)} · Nap</title>
<style>
  :root { color-scheme: light dark; }
  body { display: grid; min-height: 100vh; margin: 0; place-items: center; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 28rem; padding: 24px; text-align: center; }
  h1 { font-size: 18px; font-weight: 600; }
  p { opacity: .7; }
  a { color: inherit; }
</style>
</head>
<body><main><h1>${text(title)}</h1><p>${text(message)}</p><a href="${text(dashboard)}">Go to Nap</a></main></body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      },
    },
  );
}

function text(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
