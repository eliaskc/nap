import { randomString, sha256Hex } from "~/lib/agent-auth";
import { handleSiteCommentsRequest } from "~/lib/comments";
import { ensureProfile, getIdentity, json, objectKey, type Identity } from "~/lib/nap-server";
import { toolbarPage } from "~/lib/nap-toolbar";
import { findRedirect } from "~/lib/rekey";
import { ARTIFACT_PATH, napUrl, type NapPlace } from "~/lib/nap-urls";
import { handleSiteAccessRequest, isCrossSite } from "~/lib/site-access";
import { handleSiteDataRequest } from "~/lib/site-data";
import { serveSiteDataClient } from "~/lib/site-data-client";
import { handleLiveRequest, publishChange, type SiteLive } from "~/lib/site-live";
import { handleChannelRequest, type SiteChannel } from "~/lib/site-channel";
import { fileHeaders, findViewableNap, getNapFile, normalizeRequestPath } from "~/lib/site-serving";
import { serveShareWidget } from "~/lib/share-widget";
import { findVersion, listVersions, restoreVersion } from "~/lib/versions";
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
 *   /_nap/frame/<token>/<path>          the artifact's files (token)
 *   /_nap/frame/<token>/_nap/version/<id>/<path>
 *                                       an earlier version's files, for the history preview
 */

type ViewerEnv = {
  DB: D1Database;
  SITES: R2Bucket;
  LIVE?: DurableObjectNamespace<SiteLive>;
  CHANNELS?: DurableObjectNamespace<SiteChannel>;
};

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
export async function handleArtifactPage(
  env: ViewerEnv,
  request: Request,
  place: NapPlace,
  ctx?: ExecutionContext,
) {
  const url = new URL(request.url);
  const match = url.pathname.match(ARTIFACT_ROUTE);
  if (!match) return statusPage(404, "Artifact not found", "The link is wrong.", place);
  const slug = match[1];
  const rest = match[2] ?? "";

  if (rest === "/_nap/access") return handleSiteAccessRequest(env, slug, request);
  if (rest === "/_nap/comments" || rest.startsWith("/_nap/comments/")) {
    return handleSiteCommentsRequest(env, slug, request, rest.slice("/_nap/comments".length));
  }
  if (rest === "/_nap/versions") return handleArtifactVersionsRequest(env, slug, request);
  if (rest.startsWith("/_nap/")) return new Response("Not found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const identity = getIdentity(request);
  const access = await findViewableNap(env.DB, slug, identity.email);
  if (access.status === "missing") {
    // An old URL of a nap that has a new key now, such as a site that moved to Artifacts.
    const moved = await findRedirect(env.DB, slug);
    if (moved) return redirect(`${ARTIFACT_PATH}/${moved}${rest}${url.search}`);
    return statusPage(404, "Artifact not found", "The link is wrong, or it was deleted.", place);
  }
  // It moved to its own host. Old artifact links keep working.
  if (access.nap.kind === "site") {
    const target = napUrl(access.nap, place).replace(/\/$/, "");
    return redirect(`${target}${rest || "/"}${url.search}`);
  }
  if (access.status === "denied") {
    return statusPage(
      403,
      "You do not have access to this artifact",
      "Ask the owner to share it with you.",
      place,
    );
  }

  // The frame token is written with this person's email, which must have a profile.
  await ensureProfile(env.DB, identity);
  const token = randomString(32);
  await env.DB.prepare(
    `INSERT INTO artifact_frames (token_hash, site_slug, email, expires_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${FRAME_TOKEN_HOURS} hours'))`,
  )
    .bind(await sha256Hex(token), slug, identity.email)
    .run();
  const cleanup = env.DB.prepare(
    "DELETE FROM artifact_frames WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  )
    .run()
    .catch(() => undefined);
  if (ctx) ctx.waitUntil(cleanup);
  else await cleanup;

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
}

/** <root>/_nap/frame/<token>/<path>. Access bypasses this path: never use getIdentity() here. */
export async function handleFrameRequest(env: ViewerEnv, request: Request, ctx?: ExecutionContext) {
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
          "access-control-allow-headers": "content-type, if-match, if-none-match",
          "access-control-max-age": "600",
        },
      }),
    );
  }

  const frame = await env.DB.prepare(
    `SELECT artifact_frames.site_slug AS slug, artifact_frames.email,
            profiles.display_name AS name, artifact_frames.expires_at AS expiresAt
     FROM artifact_frames LEFT JOIN profiles ON profiles.email = artifact_frames.email
     WHERE artifact_frames.token_hash = ?
       AND artifact_frames.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(await sha256Hex(token))
    .first<{ slug: string; email: string; name: string | null; expiresAt: string }>();
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
    return withCors(json(identity, { headers: { "cache-control": "no-store" } }));
  }
  if (rest.startsWith("/_nap/data/")) {
    const path = rest.slice("/_nap/data/".length);
    return withCors(
      await handleSiteDataRequest(env, frame.slug, request, path, {
        frameIdentity: identity,
        onChange: (collection, change) =>
          publishChange(env, ctx && ((p) => ctx.waitUntil(p)), frame.slug, collection, change),
      }),
    );
  }
  // A WebSocket response cannot get new headers, and WebSockets do not use CORS.
  // The socket closes when the frame token expires.
  if (rest === "/_nap/live") {
    return handleLiveRequest(env, frame.slug, request, identity, frame.expiresAt);
  }
  if (rest.startsWith("/_nap/channel/")) {
    const name = rest.slice("/_nap/channel/".length);
    return handleChannelRequest(env, frame.slug, name, request, identity, frame.expiresAt);
  }
  if (rest.startsWith("/_nap/")) return withCors(new Response("Not found", { status: 404 }));

  if (request.method !== "GET" && request.method !== "HEAD") {
    return withCors(new Response("Method not allowed", { status: 405 }));
  }

  // Access can change while a page is open. Check it on every request.
  const access = await findViewableNap(env.DB, frame.slug, frame.email);
  if (access.status !== "allowed" || access.nap.kind !== "artifact") {
    return withCors(new Response("Not found", { status: 404 }));
  }

  const normalizedPath = normalizeRequestPath(safeDecode(rest));
  let object: R2ObjectBody | null;
  if (previewVersion) {
    // Previews do not count as views.
    if (!(await findVersion(env.DB, frame.slug, previewVersion))) {
      return withCors(new Response("Version not found", { status: 404 }));
    }
    object = await env.SITES.get(objectKey(frame.slug, previewVersion, normalizedPath));
  } else {
    object = await getNapFile(env, access.nap, normalizedPath);
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
}

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
 * - Tell the viewer the page's path and title, so the address bar and the tab title follow.
 */
function frameScript(prefix: string, viewerOrigin: string) {
  return `(function(){var P=${JSON.stringify(prefix)},O=${JSON.stringify(viewerOrigin)};
function mem(){var m=new Map();return{get length(){return m.size},key:function(i){var k=Array.from(m.keys())[i];return k===undefined?null:k},getItem:function(k){k=String(k);return m.has(k)?m.get(k):null},setItem:function(k,v){m.set(String(k),String(v))},removeItem:function(k){m.delete(String(k))},clear:function(){m.clear()}}}
["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(e2){}}});
if(window.parent===window)return;
function post(){try{var p=location.pathname;if(p.indexOf(P)===0)p=p.slice(P.length)||"/";parent.postMessage({type:"nap:location",path:p+location.search+location.hash,title:document.title},O)}catch(e){}}
["pushState","replaceState"].forEach(function(n){var o=history[n];history[n]=function(){var r=o.apply(this,arguments);post();return r}});
addEventListener("popstate",post);addEventListener("hashchange",post);
addEventListener("DOMContentLoaded",function(){post();var t=document.querySelector("title");if(t)new MutationObserver(post).observe(t,{childList:true,characterData:true,subtree:true})});
post();})();`;
}

/**
 * /artifact/<slug>/_nap/versions, for the history button in the Nap bar (Access).
 * GET lists the versions, newest first. POST { version, expectedCurrentVersion } makes one live.
 */
async function handleArtifactVersionsRequest(
  env: { DB: D1Database },
  slug: string,
  request: Request,
) {
  const identity = getIdentity(request);
  const access = await findViewableNap(env.DB, slug, identity.email);
  if (access.status !== "allowed") return json({ error: "Not found" }, { status: 404 });

  if (request.method === "GET") {
    const site = await env.DB.prepare(
      "SELECT source_repo IS NOT NULL AS hasSource FROM sites WHERE slug = ?",
    )
      .bind(slug)
      .first<{ hasSource: number }>();
    return json(
      { versions: await listVersions(env.DB, slug), hasSource: Boolean(site?.hasSource) },
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (request.method === "POST") {
    if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return json({ error: "Expected JSON" }, { status: 415 });
    }
    await ensureProfile(env.DB, identity);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return restoreVersion(env.DB, identity.email, slug, body);
  }
  return json({ error: "Method not allowed" }, { status: 405 });
}

function withCors(response: Response) {
  // The frame's origin is opaque ("null"), so its own fetches and module scripts are
  // cross-origin. The token in the path is the credential, not a cookie.
  const result = new Response(response.body, response);
  result.headers.set("access-control-allow-origin", "*");
  return result;
}

function safeDecode(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
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
