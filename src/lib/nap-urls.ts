/**
 * Where a nap lives. One rule:
 *
 * - A site (a nap with a chosen URL) has its own host: <slug>.<root>. Real origin, real
 *   localStorage, root-absolute paths work.
 * - An artifact is at <root>/<id>. Nap shows it in a sandboxed frame below a small bar. Its id
 *   shares the root domain's first path segment with Nap's own routes, which are reserved
 *   (RESERVED_SLUGS in uploads.ts) and always win.
 *
 * Local development has one host: sites are at /s/<slug>/ and artifacts at /<id>.
 * The functions here run on the server and in the browser.
 */

import { napConfig } from "~/nap.config";

export type NapKind = "site" | "artifact";

/** Old artifact links, <root>/artifact/<id>[/<path>], redirect to <root>/<id>[/<path>]. */
export const LEGACY_ARTIFACT_PATH = "/artifact";

/** An artifact's path on the root domain: /<id>. */
export function artifactPath(slug: string) {
  return `/${slug}`;
}

export type NapPlace = {
  rootDomain: string;
  /** The local dev origin (for example http://localhost:3000). Unset in production. */
  localOrigin?: string | null;
};

export function napUrl(nap: { slug: string; kind: NapKind }, place: NapPlace) {
  if (nap.kind === "artifact") {
    const origin = place.localOrigin || `https://${place.rootDomain}`;
    return `${origin}${artifactPath(nap.slug)}`;
  }
  if (place.localOrigin) return `${place.localOrigin}/s/${nap.slug}/`;
  return `https://${nap.slug}.${place.rootDomain}/`;
}

/** The URL without the scheme, for labels: elo.<root>, <root>/x. */
export function napLabel(nap: { slug: string; kind: NapKind }, rootDomain: string) {
  return nap.kind === "artifact"
    ? `${rootDomain}${artifactPath(nap.slug)}`
    : `${nap.slug}.${rootDomain}`;
}

export function isLocalHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** For browser code: the place of the current page. */
export function browserPlace(rootDomain = napConfig.rootDomain): NapPlace {
  if (typeof window === "undefined") return { rootDomain };
  const { hostname, origin } = window.location;
  if (isLocalHostname(hostname)) return { rootDomain, localOrigin: origin };
  return { rootDomain: hostname };
}
