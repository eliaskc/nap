import { Effect } from "effect";
import { getIdentity, objectKey } from "~/lib/nap-server";
import { toolbarPage } from "~/lib/nap-toolbar";
import type { NapKind } from "~/lib/nap-urls";
import { findRedirect } from "~/lib/rekey";
import { canViewSite, isSameEmail, type Visibility } from "~/lib/site-access";
import { siteManifest } from "~/lib/site-manifest";
import { Database, type DatabaseError } from "~/server/database";
import { failText, redirect } from "~/server/http";
import { Storage } from "~/server/storage";
import { recordVisit } from "~/lib/visits";

export type ServedNap = {
  slug: string;
  kind: NapKind;
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
    `SELECT sites.slug, sites.kind, sites.title, sites.current_version AS currentVersion,
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
 * Serves a site at <slug>.<root> (or /s/<slug>/ locally). Artifacts are not served here: a visit
 * redirects to the artifact page, so old links keep working.
 */
export const serveUploadedSite = Effect.fn("serveUploadedSite")(function* (
  slug: string,
  path: string,
  request: Request,
  options: { accessPath?: string; dashboardUrl?: string; artifactUrl: (slug: string) => string },
) {
  const url = new URL(request.url);
  const identity = getIdentity(request);
  const access = yield* findViewableNap(slug, identity.email);
  const rest = path.replace(/^\/+/, "");
  const toArtifact = (key: string) =>
    redirect(`${options.artifactUrl(key)}${rest ? `/${rest}` : ""}${url.search}`);
  if (access.status === "missing") {
    // A site that moved to Artifacts has a new id. The artifact page sends sites to their host.
    const moved = yield* findRedirect(slug);
    if (moved) return toArtifact(moved);
    return yield* failText(404, "Site not found");
  }

  if (access.nap.kind === "artifact") return toArtifact(slug);
  if (access.status === "denied") {
    return yield* failText(403, "You do not have access to this site");
  }
  const { nap, isOwner } = access;
  const normalizedPath = normalizeRequestPath(path);
  if (isPageVisit(request, normalizedPath)) yield* recordVisit(identity.email, nap.slug);

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

  let object = yield* getNapFile(nap, normalizedPath);
  // A folder without its slash: /games/connections means /games/connections/.
  if (!object && !/\.[a-z0-9]+$/i.test(normalizedPath)) {
    const folderIndex = `${normalizedPath}/index.html`;
    if (!url.pathname.endsWith("/")) {
      const storage = yield* Storage;
      const exists = yield* storage.head(objectKey(nap.slug, nap.currentVersion, folderIndex));
      if (exists) return redirect(`${url.pathname}/${url.search}`);
    } else {
      // Locally the route drops the trailing slash from the path.
      object = yield* getNapFile(nap, folderIndex);
    }
  }
  // A single-page app ("spa": true in nap.json): page paths without a file get the root
  // index.html, and the app's router shows the page. Missing files with an extension stay 404.
  if (!object && isPagePath(normalizedPath, request)) {
    if ((yield* siteManifest(nap.slug, nap.currentVersion)).spa) {
      object = yield* getNapFile(nap, "index.html");
    }
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

/** Reads a file of the live version. Opening index.html counts as a view. */
export const getNapFile = Effect.fn("getNapFile")(function* (
  nap: ServedNap,
  normalizedPath: string,
) {
  const storage = yield* Storage;
  const object = yield* storage.get(objectKey(nap.slug, nap.currentVersion, normalizedPath));
  if (object && normalizedPath.endsWith("index.html")) {
    const db = yield* Database;
    yield* db.run(
      `UPDATE sites
       SET view_count = view_count + 1,
           last_viewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE slug = ?`,
      nap.slug,
    );
  }
  return object;
});

export function fileHeaders(object: R2ObjectBody) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "no-store");
  return headers;
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

/** Old artifact host. `artifacts.<root>/<slug>` now redirects to `<root>/artifact/<slug>`. */
export const ARTIFACTS_LABEL = "artifacts";

export type HostTarget =
  | { type: "dashboard" }
  | { type: "site"; slug: string }
  | { type: "artifacts" }
  | { type: "unknown" };

/**
 * <root>                       dashboard, and artifacts at /artifact/<slug>
 * <slug>.<root>                a site (one origin each); artifacts redirect to /artifact/<slug>
 * artifacts.<root>             old artifact links (/<slug>), redirected
 */
export function resolveHost(host: string, rootDomain: string): HostTarget {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  const root = rootDomain.toLowerCase();
  if (hostname === root || !hostname.endsWith(`.${root}`)) return { type: "dashboard" };

  const labels = hostname.slice(0, -(root.length + 1)).split(".");
  if (labels.length === 1 && labels[0] === ARTIFACTS_LABEL) return { type: "artifacts" };
  if (labels.length === 1 && labels[0]) return { type: "site", slug: labels[0] };
  return { type: "unknown" };
}

export function normalizeRequestPath(path: string) {
  const clean = path.replace(/^\/+/, "");
  if (!clean || clean.endsWith("/")) return `${clean}index.html`;
  return clean;
}
