import { getIdentity, objectKey } from "~/lib/nap-server";
import { toolbarPage } from "~/lib/nap-toolbar";
import type { NapKind } from "~/lib/nap-urls";
import { findRedirect } from "~/lib/rekey";
import { canViewSite, isSameEmail, type Visibility } from "~/lib/site-access";

type SiteServingEnv = {
  DB: D1Database;
  SITES: R2Bucket;
};

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
export async function findViewableNap(
  db: D1Database,
  slug: string,
  email: string,
): Promise<NapAccess> {
  const nap = await db
    .prepare(
      `SELECT sites.slug, sites.kind, sites.title, sites.current_version AS currentVersion,
              sites.visibility, sites.created_by_email AS createdByEmail,
              sites.updated_at AS updatedAt, sites.toolbar, profiles.display_name AS ownerName
       FROM sites LEFT JOIN profiles ON profiles.email = sites.created_by_email
       WHERE sites.slug = ?`,
    )
    .bind(slug)
    .first<ServedNap>();
  if (!nap) return { status: "missing" };

  const isOwner = isSameEmail(nap.createdByEmail, email);
  const allowed = await canViewSite(db, nap, email);
  return allowed ? { status: "allowed", nap, isOwner } : { status: "denied", nap };
}

/**
 * Serves a site at <slug>.<root> (or /s/<slug>/ locally). Artifacts are not served here: a visit
 * redirects to the artifact page, so old links keep working.
 */
export async function serveUploadedSite(
  env: SiteServingEnv,
  slug: string,
  path: string,
  request: Request,
  options: { accessPath?: string; dashboardUrl?: string; artifactUrl: (slug: string) => string },
) {
  const url = new URL(request.url);
  const access = await findViewableNap(env.DB, slug, getIdentity(request).email);
  const rest = path.replace(/^\/+/, "");
  const toArtifact = (key: string) =>
    redirect(`${options.artifactUrl(key)}${rest ? `/${rest}` : ""}${url.search}`);
  if (access.status === "missing") {
    // A site that moved to Artifacts has a new id. The artifact page sends sites to their host.
    const moved = await findRedirect(env.DB, slug);
    if (moved) return toArtifact(moved);
    return new Response("Site not found", { status: 404 });
  }

  if (access.nap.kind === "artifact") return toArtifact(slug);
  if (access.status === "denied") {
    return new Response("You do not have access to this site", { status: 403 });
  }
  const { nap, isOwner } = access;
  const normalizedPath = normalizeRequestPath(path);

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

  let object = await getNapFile(env, nap, normalizedPath);
  // A folder without its slash: /games/connections means /games/connections/.
  if (!object && !/\.[a-z0-9]+$/i.test(normalizedPath)) {
    const folderIndex = `${normalizedPath}/index.html`;
    if (!url.pathname.endsWith("/")) {
      const exists = await env.SITES.head(objectKey(nap.slug, nap.currentVersion, folderIndex));
      if (exists) return redirect(`${url.pathname}/${url.search}`);
    } else {
      // Locally the route drops the trailing slash from the path.
      object = await getNapFile(env, nap, folderIndex);
    }
  }
  if (!object) return new Response("File not found", { status: 404 });

  const headers = fileHeaders(object);
  if (nap.toolbar) {
    // The toolbar page frames the files from the same host. Nobody else may frame them.
    headers.set("content-security-policy", "frame-ancestors 'self'");
    headers.set("vary", "sec-fetch-dest");
  }
  return new Response(object.body, { headers });
}

/** Reads a file of the live version. Opening index.html counts as a view. */
export async function getNapFile(env: SiteServingEnv, nap: ServedNap, normalizedPath: string) {
  const object = await env.SITES.get(objectKey(nap.slug, nap.currentVersion, normalizedPath));
  if (object && normalizedPath.endsWith("index.html")) {
    await env.DB.prepare(
      `UPDATE sites
       SET view_count = view_count + 1,
           last_viewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE slug = ?`,
    )
      .bind(nap.slug)
      .run();
  }
  return object;
}

export function fileHeaders(object: R2ObjectBody) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "no-store");
  return headers;
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

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}
