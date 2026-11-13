import handler from "@tanstack/react-start/server-entry";
import { Effect } from "effect";
import { handleAgentApi } from "~/lib/agent-api";
import { handleVisitorAccessRequest } from "~/lib/access-requests";
import { handleSlackHook } from "~/lib/access-slack";
import { serveAccessScript } from "~/lib/no-access-page";
import {
  handleArtifactPage,
  handleFrameRequest,
  isArtifactPath,
  isFramePath,
} from "~/lib/artifact-viewer";
import { handleCreateDraft } from "~/lib/drafts";
import { ensureProfile, getIdentity } from "~/lib/nap-server";
import { serveToolbarScript, serveViewerScript } from "~/lib/nap-toolbar";
import { ARTIFACT_PATH, type NapPlace } from "~/lib/nap-urls";
import { handleSiteAccessRequest } from "~/lib/site-access";
import { handleSiteDataRequest, siteDataTarget } from "~/lib/site-data";
import { serveClientTypes, serveSiteDataClient, serveVoiceEngine } from "~/lib/site-data-client";
import { handleLiveRequest, publishChange } from "~/lib/site-live";
import { handleNotifyRequest } from "~/lib/notifications";
import { handleChannelRequest } from "~/lib/site-channel";
import { handleRtcRequest } from "~/lib/site-rtc";
import { handleSiteFetch } from "~/lib/site-fetch";
import { handleSiteFilesRequest } from "~/lib/site-files";
import { EXTENSIONS } from "~/lib/extension-registry";
import { handleExtensionRequest } from "~/lib/extensions";
import { resolveHost, serveUploadedSite } from "~/lib/site-serving";
import { serveShareWidget } from "~/lib/share-widget";
import { meResponse, peopleResponse, welcomeRedirect } from "~/lib/welcome";
import { inBackground, Settings } from "~/server/platform";
import { respond, type NapEnv } from "~/server/runtime";

type Env = Cloudflare.Env;

// The Worker runtime instantiates Durable Object classes from the entry module's exports.
export { SiteLive } from "~/lib/site-live";
export { SiteChannel } from "~/lib/site-channel";
export { AppSigner } from "~/lib/app-signer";

/** Collections for a site, with each committed write sent to the site's open pages. */
/** /_nap/data/<path> on a site's host: its own collections, or `@<site>/...` another site's. */
const siteData = (hostSlug: string, request: Request, path: string) => {
  const { slug, path: rest, from } = siteDataTarget(hostSlug, path);
  return handleSiteDataRequest(slug, request, rest, {
    from,
    onChange: (collection, change) => publishChange(slug, collection, change),
  });
};

/** Routes a request by host and path. Everything else goes to the TanStack app. */
const routeRequest = Effect.fn("routeRequest")(function* (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  const { rootDomain } = yield* Settings;
  const url = new URL(request.url);
  const target = resolveHost(request.headers.get("host") ?? "", rootDomain);
  const isLocal = ["localhost", "127.0.0.1"].includes(url.hostname);
  const place: NapPlace = { rootDomain, localOrigin: isLocal ? url.origin : null };
  const dashboardOrigin = isLocal ? url.origin : `https://${rootDomain}`;
  /** People without a name go to the welcome page first. */
  const welcome = () => welcomeRedirect(request, dashboardOrigin, isLocal);

  if (url.pathname === "/_nap/client.js" && request.method === "GET") {
    return serveSiteDataClient();
  }
  if (url.pathname === "/_nap/client-voice.js" && request.method === "GET") {
    return serveVoiceEngine(request);
  }
  if (url.pathname === "/_nap/client.d.ts" && request.method === "GET") {
    return serveClientTypes();
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
  if (url.pathname === "/_nap/access.js" && request.method === "GET") {
    return serveAccessScript();
  }
  // The comments UI for the Nap bar on artifact pages, built from src/comments into the assets.
  if (
    target.type === "dashboard" &&
    url.pathname === "/_nap/comments.js" &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    return yield* Effect.promise(() => env.ASSETS.fetch(request));
  }

  // Access bypasses these paths on the dashboard host. None may use getIdentity().
  // Draft uploads need no login. The agent API checks its own tokens. Artifact frames check
  // their frame tokens.
  if (target.type === "dashboard" && url.pathname === "/_nap/drafts") {
    return yield* handleCreateDraft(request);
  }
  if (
    target.type === "dashboard" &&
    (url.pathname === "/_nap/api" || url.pathname.startsWith("/_nap/api/"))
  ) {
    return yield* handleAgentApi(request);
  }
  if (target.type === "dashboard" && isFramePath(url.pathname)) {
    return yield* handleFrameRequest(request);
  }
  // Slack, when an owner clicks a button on an access request. Checks Slack's signature.
  if (target.type === "dashboard" && url.pathname === "/_nap/hooks/slack") {
    return yield* handleSlackHook(request, place);
  }

  // Artifacts: <root>/artifact/<slug>, a sandboxed frame below the Nap bar.
  if (target.type === "dashboard" && isArtifactPath(url.pathname)) {
    const toWelcome = yield* welcome();
    if (toWelcome) return toWelcome;
    return yield* handleArtifactPage(request, place);
  }

  if (isLocal) {
    const localDataMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/data\/(.+)$/);
    if (localDataMatch) {
      return yield* siteData(localDataMatch[1], request, localDataMatch[2]);
    }
    const localFilesMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/files(?:\/(.*))?$/);
    if (localFilesMatch) {
      return yield* handleSiteFilesRequest(localFilesMatch[1], request, localFilesMatch[2] ?? "");
    }
    const localLiveMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/live$/);
    if (localLiveMatch) {
      return yield* handleLiveRequest(localLiveMatch[1], request, getIdentity(request));
    }
    const localChannelMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/channel\/([^/]+)$/);
    if (localChannelMatch) {
      const [, localSlug, name] = localChannelMatch;
      return yield* handleChannelRequest(localSlug, name, request, getIdentity(request));
    }
    const localRtcMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/rtc$/);
    if (localRtcMatch) {
      return yield* handleRtcRequest(localRtcMatch[1], request, getIdentity(request));
    }
    const localExtensionMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/ext\/(.+)$/);
    if (localExtensionMatch) {
      const [, localSlug, path] = localExtensionMatch;
      return yield* handleExtensionRequest(
        EXTENSIONS,
        localSlug,
        request,
        getIdentity(request),
        path,
      );
    }
    const localNotifyMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/notify$/);
    if (localNotifyMatch) {
      return yield* handleNotifyRequest(localNotifyMatch[1], request, getIdentity(request), place);
    }
    const localFetchMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/fetch$/);
    if (localFetchMatch) {
      return yield* handleSiteFetch(localFetchMatch[1], request, getIdentity(request).email);
    }
    if (/^\/s\/[^/]+\/_nap\/me$/.test(url.pathname) && request.method === "GET") {
      return yield* meResponse(getIdentity(request));
    }
    if (/^\/s\/[^/]+\/_nap\/people$/.test(url.pathname) && request.method === "GET") {
      return yield* peopleResponse(request);
    }
    const localRequestMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/access\/(request|status)$/);
    if (localRequestMatch) {
      const [, localSlug, action] = localRequestMatch;
      return yield* handleVisitorAccessRequest(
        localSlug,
        action as "request" | "status",
        request,
        getIdentity(request),
        place,
      );
    }
    const localAccessMatch = url.pathname.match(/^\/s\/([^/]+)\/_nap\/access$/);
    if (localAccessMatch) {
      return yield* handleSiteAccessRequest(localAccessMatch[1], request);
    }
    // Old local artifact viewer links.
    const localViewerMatch = url.pathname.match(/^\/a\/([^/]+)\/?$/);
    if (localViewerMatch && request.method === "GET") {
      return Response.redirect(`${url.origin}${ARTIFACT_PATH}/${localViewerMatch[1]}`, 302);
    }
  }

  // <slug>.<root> serves one site. Each site has its own origin, so sites cannot read each
  // other's data, except collections another site's nap.json allows them (/_nap/data/@<site>/).
  // Artifacts redirect to <root>/artifact/<slug>.
  if (target.type === "site") {
    const slug = target.slug;
    // Opening a nap counts as using Nap. It keeps the person's agent tokens active.
    if (
      request.headers.get("sec-fetch-dest") === "document" &&
      request.headers.get("cf-access-authenticated-user-email")
    ) {
      yield* inBackground(ensureProfile(getIdentity(request)), "Recording a visit failed");
    }
    if (url.pathname === "/_nap/me" && request.method === "GET") {
      return yield* meResponse(getIdentity(request));
    }
    if (url.pathname === "/_nap/people" && request.method === "GET") {
      return yield* peopleResponse(request);
    }
    if (url.pathname === "/_nap/access") {
      return yield* handleSiteAccessRequest(slug, request);
    }
    if (url.pathname === "/_nap/access/request" || url.pathname === "/_nap/access/status") {
      return yield* handleVisitorAccessRequest(
        slug,
        url.pathname === "/_nap/access/request" ? "request" : "status",
        request,
        getIdentity(request),
        place,
      );
    }
    // The old artifact viewer sent tabs here once. Keep those links working.
    if (url.pathname === "/_nap/session" && request.method === "GET") {
      return Response.redirect(`https://${slug}.${rootDomain}/`, 302);
    }
    if (url.pathname.startsWith("/_nap/data/")) {
      return yield* siteData(slug, request, url.pathname.slice("/_nap/data/".length));
    }
    if (url.pathname === "/_nap/files" || url.pathname.startsWith("/_nap/files/")) {
      return yield* handleSiteFilesRequest(slug, request, url.pathname.slice("/_nap/files".length));
    }
    if (url.pathname === "/_nap/live") {
      return yield* handleLiveRequest(slug, request, getIdentity(request));
    }
    if (url.pathname.startsWith("/_nap/channel/")) {
      const name = url.pathname.slice("/_nap/channel/".length);
      return yield* handleChannelRequest(slug, name, request, getIdentity(request));
    }
    if (url.pathname === "/_nap/rtc") {
      return yield* handleRtcRequest(slug, request, getIdentity(request));
    }
    if (url.pathname === "/_nap/fetch") {
      return yield* handleSiteFetch(slug, request, getIdentity(request).email);
    }
    if (url.pathname === "/_nap/notify") {
      return yield* handleNotifyRequest(slug, request, getIdentity(request), place);
    }
    if (url.pathname.startsWith("/_nap/ext/")) {
      const path = url.pathname.slice("/_nap/ext/".length);
      return yield* handleExtensionRequest(EXTENSIONS, slug, request, getIdentity(request), path);
    }
    const toWelcome = yield* welcome();
    if (toWelcome) return toWelcome;
    return yield* serveUploadedSite(slug, url.pathname, request, {
      dashboardUrl: `https://${rootDomain}/`,
      napFavicon: Effect.promise(() =>
        env.ASSETS.fetch(new Request(new URL("/favicon.ico", dashboardOrigin), request)),
      ),
      artifactUrl: (key) => `https://${rootDomain}${ARTIFACT_PATH}/${key}`,
      signOutUrl: "/cdn-cgi/access/logout",
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

  // Dashboard pages, except the welcome page itself and the API.
  if (!url.pathname.startsWith("/_nap/") && !url.pathname.startsWith("/api/")) {
    const toWelcome = yield* welcome();
    if (toWelcome) return toWelcome;
  }

  // Worker-first routing keeps uploaded hosts out of the dashboard asset namespace.
  // Serve dashboard assets only after the hosted-site branch above.
  if (request.method === "GET" || request.method === "HEAD") {
    const asset = yield* Effect.promise(() => env.ASSETS.fetch(request));
    if (asset.status !== 404) return asset;
  }

  return yield* Effect.promise(() =>
    (handler.fetch as (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>)(
      request,
      env,
      ctx,
    ),
  );
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return respond(env as unknown as NapEnv, routeRequest(request, env, ctx), ctx);
  },
};
