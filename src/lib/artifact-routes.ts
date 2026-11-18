import { Effect } from "effect";
import { artifactPath, LEGACY_ARTIFACT_PATH } from "~/lib/nap-urls";
import { isReservedSlug } from "~/lib/uploads";
import { Database } from "~/server/database";
import { redirect } from "~/server/http";

/**
 * Where artifacts are on the root domain: <root>/<id>[/<path>], and old links at
 * <root>/artifact/<id>[/<path>]. The id shares the first path segment with Nap's own routes
 * (/api, /connect, /_nap, ...). Those are reserved names (RESERVED_SLUGS in uploads.ts) and always
 * win: a path is an artifact only when its first segment is not reserved, and only when a nap has
 * that name; anything else goes on to Nap's normal 404. artifact-viewer.ts serves the page.
 */

const ARTIFACT_ROUTE = /^\/([a-z0-9-]{1,32})(\/.*)?$/;
const LEGACY_ARTIFACT_ROUTE = new RegExp(`^${LEGACY_ARTIFACT_PATH}/([a-z0-9-]{1,32})(/.*)?$`);

/** An artifact page and what is below it. `base` is the page's own path, for the bar's URLs. */
export type ArtifactRoute = { slug: string; rest: string; base: string };

/**
 * <root>/<name>[/<path>] when <name> may be an artifact: a valid id that is none of Nap's own
 * routes. Null for everything else, which Nap serves itself.
 */
export function artifactRoute(pathname: string): ArtifactRoute | null {
  const match = pathname.match(ARTIFACT_ROUTE);
  if (!match || isReservedSlug(match[1])) return null;
  return { slug: match[1], rest: match[2] ?? "", base: artifactPath(match[1]) };
}

/** Old links: <root>/artifact/<id>[/<path>]. */
export function legacyArtifactRoute(pathname: string): ArtifactRoute | null {
  const match = pathname.match(LEGACY_ARTIFACT_ROUTE);
  if (!match) return null;
  return { slug: match[1], rest: match[2] ?? "", base: `${LEGACY_ARTIFACT_PATH}/${match[1]}` };
}

/**
 * Old artifact links move to <root>/<id>, with the same path and query. Permanent: 301 for GET
 * and HEAD, 308 for the rest, so a bar that was open before the move still renews its frame token.
 */
export function legacyArtifactRedirect(request: Request, route: ArtifactRoute) {
  const url = new URL(request.url);
  const permanent = request.method === "GET" || request.method === "HEAD" ? 301 : 308;
  return redirect(`${artifactPath(route.slug)}${route.rest}${url.search}`, permanent);
}

/** Whether a name is a nap, or an old name of one. Other names get Nap's normal 404. */
export const isNapName = Effect.fn("isNapName")(function* (slug: string) {
  const db = yield* Database;
  const row = yield* db.first(
    `SELECT 1 AS found FROM sites WHERE slug = ?
     UNION ALL SELECT 1 AS found FROM nap_redirects WHERE slug = ?
     LIMIT 1`,
    slug,
    slug,
  );
  return Boolean(row);
});
