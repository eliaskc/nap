import handler from "@tanstack/react-start/server-entry";
import { handleAgentApi } from "~/lib/agent-api";
import { napConfig } from "~/nap.config";
import {
  handleArtifactPage,
  handleFrameRequest,
  isArtifactPath,
  isFramePath,
} from "~/lib/artifact-viewer";
import { handleCreateDraft } from "~/lib/drafts";
import { handleInstallRequest, isInstallPath } from "~/lib/apps";
import { handleEnrollRequest, isEnrollPath } from "~/lib/devices";
import { ensureProfile, getIdentity } from "~/lib/nap-server";
import { serveToolbarScript, serveViewerScript } from "~/lib/nap-toolbar";
import { ARTIFACT_PATH, type NapPlace } from "~/lib/nap-urls";
import { handleSiteAccessRequest } from "~/lib/site-access";
import { handleSiteDataRequest } from "~/lib/site-data";
import { serveSiteDataClient } from "~/lib/site-data-client";
import { handleLiveRequest, publishChange } from "~/lib/site-live";
import { handleChannelRequest } from "~/lib/site-channel";
import { handleRtcRequest } from "~/lib/site-rtc";
import { handleSiteFetch } from "~/lib/site-fetch";
import { resolveHost, serveUploadedSite } from "~/lib/site-serving";
import { serveShareWidget } from "~/lib/share-widget";

function identityResponse(request: Request) {
  return new Response(JSON.stringify(getIdentity(request)), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

type Env = Cloudflare.Env;

// The Worker runtime instantiates Durable Object classes from the entry module's exports.
export { SiteLive } from "~/lib/site-live";
export { SiteChannel } from "~/lib/site-channel";
export { AppSigner } from "~/lib/app-signer";

/** Collections for a site, with each committed write sent to the site's open pages. */
function siteData(env: Env, ctx: ExecutionContext, slug: string, request: Request, path: string) {
  return handleSiteDataRequest(env, slug, request, path, {
    onChange: (collection, change) =>
      publishChange(env, (p) => ctx.waitUntil(p), slug, collection, change),
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const rootDomain = env.NAP_ROOT_DOMAIN || napConfig.rootDomain;
    const url = new URL(request.url);
    const target = resolveHost(request.headers.get("host") ?? "", rootDomain);
    const isLocal = ["localhost", "127.0.0.1"].includes(url.hostname);
    const place: NapPlace = { rootDomain, localOrigin: isLocal ? url.origin : null };

    if (url.pathname === "/_nap/client.js" && request.method === "GET") {
      return serveSiteDataClient();
    }
    if (url.pathname === "/_nap/share.js" && request.method === "GET") {
      return serveShareWidget();
    }
    if (url.pathname === "/_nap/toolbar.js" && request.method === "GET") {
      return serveToolbarScript();
    }
    if (url.pathname === "/_nap/viewer.js" && request.method === "GET") {
      return serveViewerScript();
    }
    // The comments UI for the Nap bar on artifact pages, built from src/comments into the assets.
    if (
      target.type === "dashboard" &&
      url.pathname === "/_nap/comments.js" &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return env.ASSETS.fetch(request);
    }

    // Access bypasses these paths on the dashboard host. None may use getIdentity().
    // Draft uploads need no login. The agent API checks its own tokens. Artifact frames check
    // their frame tokens. App installs and iPhone enrollments check their tokens.
    if (target.type === "dashboard" && url.pathname === "/_nap/drafts") {
      return handleCreateDraft(env, request);
    }
    if (
      target.type === "dashboard" &&
      (url.pathname === "/_nap/api" || url.pathname.startsWith("/_nap/api/"))
    ) {
      return handleAgentApi(env, request, rootDomain, ctx);
    }
    if (target.type === "dashboard" && isFramePath(url.pathname)) {
      return handleFrameRequest(env, request, ctx);
    }
    // App installs: the iOS installer fetches the manifest and the .ipa without the Access
    // cookie. The install token in the path is the credential.
    if (target.type === "dashboard" && isInstallPath(url.pathname)) {
      return handleInstallRequest(env, request);
    }
    // iPhone enrollment: iOS posts the device attributes without the Access cookie. The
    // enrollment token in the path is the credential.
    if (target.type === "dashboard" && isEnrollPath(url.pathname)) {
      return handleEnrollRequest(env, request, ctx);
    }

    // Artifacts: <root>/artifact/<slug>, a sandboxed frame below the Nap bar.
    if (target.type === "dashboard" && isArtifactPath(url.pathname)) {
      return handleArtifactPage(env, request, place, ctx);
    }

    if (isLocal) {
      const localDataMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/data\/(.+)$/);
      if (localDataMatch) {
        return siteData(env, ctx, localDataMatch[1], request, localDataMatch[2]);
      }
      const localLiveMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/live$/);
      if (localLiveMatch) {
        return handleLiveRequest(env, localLiveMatch[1], request, getIdentity(request));
      }
      const localChannelMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/channel\/([^/]+)$/);
      if (localChannelMatch) {
        const [, localSlug, name] = localChannelMatch;
        return handleChannelRequest(env, localSlug, name, request, getIdentity(request));
      }
      const localRtcMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/rtc$/);
      if (localRtcMatch) {
        return handleRtcRequest(env, localRtcMatch[1], request, getIdentity(request));
      }
      const localFetchMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/fetch$/);
      if (localFetchMatch) {
        const email = getIdentity(request).email;
        return handleSiteFetch(env, localFetchMatch[1], request, email, rootDomain);
      }
      if (/^\/s\/[^/]+\/_nap\/me$/.test(url.pathname) && request.method === "GET") {
        return identityResponse(request);
      }
      const localAccessMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/access$/);
      if (localAccessMatch) {
        return handleSiteAccessRequest(env, localAccessMatch[1], request);
      }
      // Old local artifact viewer links.
      const localViewerMatch = url.pathname.match(/^\/a\/([^/]+)\/?$/);
      if (localViewerMatch && request.method === "GET") {
        return Response.redirect(`${url.origin}${ARTIFACT_PATH}/${localViewerMatch[1]}`, 302);
      }
    }

    // <slug>.<root> serves one site. Each site has its own origin, so sites cannot read each
    // other's data. Artifacts redirect to <root>/artifact/<slug>.
    if (target.type === "site") {
      const slug = target.slug;
      // Opening a nap counts as using Nap. It keeps the person's agent tokens active.
      if (
        request.headers.get("sec-fetch-dest") === "document" &&
        request.headers.get("cf-access-authenticated-user-email")
      ) {
        ctx.waitUntil(ensureProfile(env.DB, getIdentity(request)).catch(() => undefined));
      }
      if (url.pathname === "/_nap/me" && request.method === "GET") {
        return identityResponse(request);
      }
      if (url.pathname === "/_nap/access") {
        return handleSiteAccessRequest(env, slug, request);
      }
      // The old artifact viewer sent tabs here once. Keep those links working.
      if (url.pathname === "/_nap/session" && request.method === "GET") {
        return Response.redirect(`https://${slug}.${rootDomain}/`, 302);
      }
      if (url.pathname.startsWith("/_nap/data/")) {
        return siteData(env, ctx, slug, request, url.pathname.slice("/_nap/data/".length));
      }
      if (url.pathname === "/_nap/live") {
        return handleLiveRequest(env, slug, request, getIdentity(request));
      }
      if (url.pathname.startsWith("/_nap/channel/")) {
        const name = url.pathname.slice("/_nap/channel/".length);
        return handleChannelRequest(env, slug, name, request, getIdentity(request));
      }
      if (url.pathname === "/_nap/rtc") {
        return handleRtcRequest(env, slug, request, getIdentity(request));
      }
      if (url.pathname === "/_nap/fetch") {
        return handleSiteFetch(env, slug, request, getIdentity(request).email, rootDomain);
      }
      return serveUploadedSite(env, slug, url.pathname, request, {
        dashboardUrl: `https://${rootDomain}/`,
        artifactUrl: (key) => `https://${rootDomain}${ARTIFACT_PATH}/${key}`,
      });
    }

    // Old artifact links: artifacts.<root>/<slug> is now <root>/artifact/<slug>.
    if (target.type === "artifacts") {
      const id = url.pathname.match(/^\/([a-z0-9-]{1,32})\/?$/)?.[1];
      return Response.redirect(
        id ? `https://${rootDomain}${ARTIFACT_PATH}/${id}` : `https://${rootDomain}/`,
        302,
      );
    }

    if (target.type === "unknown") return new Response("Not found", { status: 404 });

    // Worker-first routing keeps uploaded hosts out of the dashboard asset namespace.
    // Serve dashboard assets only after the hosted-site branch above.
    if (request.method === "GET" || request.method === "HEAD") {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }

    return (
      handler.fetch as (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>
    )(request, env, ctx);
  },
};
