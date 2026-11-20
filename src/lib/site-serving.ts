import { Effect } from "effect";
import { getIdentity, objectKey } from "~/lib/nap-server";
import { toolbarPage } from "~/lib/nap-toolbar";
import type { NapKind } from "~/lib/nap-urls";
import { visitorRequestState } from "~/lib/access-requests";
import { noAccessHeaders, noAccessPage } from "~/lib/no-access-page";
import { findRedirect } from "~/lib/rekey";
import { canViewSite, isSameEmail, type Visibility } from "~/lib/site-access";
import { siteManifest } from "~/lib/site-manifest";
import { Database, type DatabaseError } from "~/server/database";
import { failText, redirect } from "~/server/http";
import { Storage } from "~/server/storage";
import { recordLoad, recordVisit } from "~/lib/visits";

export type ServedNap = {
  slug: string;
  kind: NapKind;
  /** "page" or "dashboard" (nap-types.ts). Unknown values count as "page". */
  type: string;
  title: string;
  currentVersion: string;
  visibility: Visibility;
  createdByEmail: string;
  ownerName: string | null;
  updatedAt: string;
  toolbar: number;
};

export type NapAccess =
  | { status: "missing" }
  | { status: "denied"; nap: ServedNap }
  | { status: "allowed"; nap: ServedNap; isOwner: boolean };

/** Finds a nap and checks if this person may view it. */
export const findViewableNap = Effect.fn("findViewableNap")(function* (
  slug: string,
  email: string,
): Effect.fn.Return<NapAccess, DatabaseError, Database> {
  const db = yield* Database;
  const nap = yield* db.first<ServedNap>(
    `SELECT sites.slug, sites.kind, sites.type, sites.title, sites.current_version AS currentVersion,
            sites.visibility, sites.created_by_email AS createdByEmail,
            sites.updated_at AS updatedAt, sites.toolbar, profiles.display_name AS ownerName
     FROM sites LEFT JOIN profiles ON profiles.email = sites.created_by_email
     WHERE sites.slug = ?`,
    slug,
  );
  if (!nap) return { status: "missing" };

  const isOwner = isSameEmail(nap.createdByEmail, email);
  const allowed = yield* canViewSite(nap, email);
  return allowed ? { status: "allowed", nap, isOwner } : { status: "denied", nap };
});

/**
 * Serves a nap on its own host, <name>.<content> (or /s/<name>/ locally): kind "site", an interim
 * mode for the naps that need a real origin. Naps in the frame are not served here: a visit
 * redirects to <root>/<name>, so links from before a move keep working.
 */
export const serveUploadedSite = Effect.fn("serveUploadedSite")(function* (
  slug: string,
  path: string,
  request: Request,
  options: {
    accessPath?: string;
    dashboardUrl?: string;
    artifactUrl: (slug: string) => string;
    /** Nap's own /favicon.ico, for sites without one. */
    napFavicon?: Effect.Effect<Response>;
    /** Signs out of Cloudflare Access, for someone signed in with the wrong account. */
    signOutUrl?: string;
  },
) {
  const url = new URL(request.url);
  const identity = getIdentity(request);
  const access = yield* findViewableNap(slug, identity.email);
  const rest = path.replace(/^\/+/, "");
  const toArtifact = (key: string) =>
    redirect(`${options.artifactUrl(key)}${rest ? `/${rest}` : ""}${url.search}`);
  if (access.status === "missing") {
    // An old name of a renamed nap. <root>/<name> sends naps on their own host back to it.
    const moved = yield* findRedirect(slug);
    if (moved) return toArtifact(moved);
    return yield* failText(404, "Nap not found");
  }

  if (access.nap.kind === "artifact") return toArtifact(slug);
  if (access.status === "denied") {
    if (!wantsHtml(request)) return yield* failText(403, "You do not have access to this nap");
    const { nap } = access;
    return yield* failText(
      403,
      noAccessPage({
        kind: "site",
        title: nap.title,
        visibility: nap.visibility,
        ownerName: nap.ownerName,
        ownerEmail: nap.createdByEmail,
        viewerEmail: identity.email,
        dashboardUrl: options.dashboardUrl ?? "/",
        signOutUrl: options.signOutUrl,
        request: yield* visitorRequestState(nap.slug, identity.email),
        accessPath: options.accessPath ?? "/_nap/access",
        back: url.pathname + url.search,
      }),
      noAccessHeaders,
    );
  }
  const { nap, isOwner } = access;
  const normalizedPath = normalizeRequestPath(path);
  if (isPageVisit(request, normalizedPath)) yield* recordVisit(identity.email, nap);

  if (nap.toolbar && wantsToolbar(request, normalizedPath)) {
    return toolbarPage({
      title: nap.title,
      owner: nap.ownerName || nap.createdByEmail,
      updatedAt: nap.updatedAt,
      isOwner,
      frameSrc: url.pathname + url.search,
      accessPath: options.accessPath ?? "/_nap/access",
      dashboardUrl: options.dashboardUrl ?? "/",
    });
  }

  let object = yield* getNapFile(nap, normalizedPath, request);
  // A folder without its slash: /games/connections means /games/connections/.
  if (!object && !/\.[a-z0-9]+$/i.test(normalizedPath)) {
    const folderIndex = `${normalizedPath}/index.html`;
    if (!url.pathname.endsWith("/")) {
      const storage = yield* Storage;
      const exists = yield* storage.head(objectKey(nap.slug, nap.currentVersion, folderIndex));
      if (exists) return redirect(`${url.pathname}/${url.search}`);
    } else {
      // Locally the route drops the trailing slash from the path.
      object = yield* getNapFile(nap, folderIndex, request);
    }
  }
  // A single-page app ("spa": true in nap.json): page paths without a file get the root
  // index.html, and the app's router shows the page. Missing files with an extension stay 404.
  if (!object && isPagePath(normalizedPath, request)) {
    if ((yield* siteManifest(nap.slug, nap.currentVersion)).spa) {
      object = yield* getNapFile(nap, "index.html", request);
    }
  }
  // Browsers ask for /favicon.ico when a page names no icon. Sites without one get Nap's.
  if (!object && normalizedPath === "favicon.ico" && options.napFavicon) {
    return yield* options.napFavicon;
  }
  if (!object) return yield* failText(404, "File not found");

  const headers = fileHeaders(object);
  if (nap.toolbar) {
    // The toolbar page frames the files from the same host. Nobody else may frame them.
    headers.set("content-security-policy", "frame-ancestors 'self'");
    headers.set("vary", "sec-fetch-dest");
  }
  return new Response(object.body, { headers });
});

/**
 * Reads a file of the live version, for a request. A GET that gets an index.html (the page, a
 * folder's page, or a single-page app's fallback) counts as a load (recordLoad), for anyone,
 * the owner too: in the frame and on a nap's own host, as before the people and views counts.
 */
export const getNapFile = Effect.fn("getNapFile")(function* (
  nap: ServedNap,
  normalizedPath: string,
  request: Request,
) {
  const storage = yield* Storage;
  const object = yield* storage.get(objectKey(nap.slug, nap.currentVersion, normalizedPath));
  if (object && request.method === "GET" && isIndexPage(normalizedPath)) {
    yield* recordLoad(nap.slug);
  }
  return object;
});

function isIndexPage(normalizedPath: string) {
  return normalizedPath === "index.html" || normalizedPath.endsWith("/index.html");
}

export function fileHeaders(object: R2ObjectBody) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "no-store");
  return headers;
}

/** A browser opening a page in a tab, not a frame, script, image, or fetch. */
function wantsHtml(request: Request) {
  if (request.method !== "GET") return false;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/** A person opening a page in the browser, not a frame, script, or fetch. */
function isPageVisit(request: Request, normalizedPath: string) {
  return (
    request.headers.get("sec-fetch-dest") === "document" && isPagePath(normalizedPath, request)
  );
}

/** A GET for a page: the last segment has no extension (index.html is what Nap adds itself). */
function isPagePath(normalizedPath: string, request: Request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const segments = normalizedPath.split("/");
  const name = segments.at(-1) === "index.html" ? (segments.at(-2) ?? "") : (segments.at(-1) ?? "");
  return !name.includes(".");
}

/**
 * A top-level page visit. Frame loads, scripts, images, and fetches get the files. Browsers
 * without Sec-Fetch-Dest also get the files, without the toolbar.
 */
function wantsToolbar(request: Request, normalizedPath: string) {
  if (request.method !== "GET") return false;
  if (request.headers.get("sec-fetch-dest") !== "document") return false;
  const name = normalizedPath.split("/").pop() ?? "";
  return /\.html?$/i.test(name) || !name.includes(".");
}

/** Old artifact host. `artifacts.<root>/<slug>` now redirects to `<root>/<slug>`. */
export const ARTIFACTS_LABEL = "artifacts";

export type HostTarget =
  | { type: "dashboard" }
  /** <name>.<content>: the one nap it serves. */
  | { type: "site"; slug: string }
  /** <name>.<root> on a deployment with a separate content domain: redirects only. */
  | { type: "moved"; slug: string }
  /** The content domain's apex and www: redirect to the dashboard. */
  | { type: "contentApex" }
  | { type: "artifacts" }
  | { type: "unknown" };

/**
 * <root>                       dashboard, and naps in the frame at /<name>
 * <name>.<content>             a nap on its own host (one origin each); naps in the frame
 *                              redirect to <root>/<name>. <content> is the content domain, by
 *                              default the root domain.
 * <name>.<root>                with a separate content domain: redirects, to <name>.<content> or
 *                              <root>/<name>, and serves nothing
 * <content>, www.<content>     with a separate content domain: redirect to the dashboard
 * artifacts.<root>             old artifact links (/<slug>), redirected
 * anything deeper              not found
 */
export function resolveHost(
  host: string,
  rootDomain: string,
  contentDomain: string = rootDomain,
): HostTarget {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  const root = rootDomain.toLowerCase();
  const content = contentDomain.toLowerCase();
  const separate = content !== root;
  if (hostname === root) return { type: "dashboard" };

  if (separate && isOnDomain(hostname, content)) {
    if (hostname === content || hostname === `www.${content}`) return { type: "contentApex" };
    const labels = hostname.slice(0, -(content.length + 1)).split(".");
    if (labels.length === 1 && labels[0]) return { type: "site", slug: labels[0] };
    return { type: "unknown" };
  }

  if (!hostname.endsWith(`.${root}`)) return { type: "dashboard" };

  const labels = hostname.slice(0, -(root.length + 1)).split(".");
  if (labels.length === 1 && labels[0] === ARTIFACTS_LABEL) return { type: "artifacts" };
  if (labels.length === 1 && labels[0]) {
    return separate ? { type: "moved", slug: labels[0] } : { type: "site", slug: labels[0] };
  }
  return { type: "unknown" };
}

/**
 * A host on a separate content domain (its apex included). Everything there runs or redirects
 * to naps' own code, behind the content domain's own Access application. False when the content
 * domain is the root domain.
 */
export function isContentDomainHost(host: string, rootDomain: string, contentDomain: string) {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  const content = contentDomain.toLowerCase();
  return content !== rootDomain.toLowerCase() && isOnDomain(hostname, content);
}

function isOnDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function normalizeRequestPath(path: string) {
  const clean = path.replace(/^\/+/, "");
  if (!clean || clean.endsWith("/")) return `${clean}index.html`;
  return clean;
}
