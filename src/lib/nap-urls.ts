/**
 * Where a nap lives. Its name is a random id or one the owner chose.
 *
 * - By default (kind "artifact") at <root>/<name>. Nap shows it in a sandboxed frame, below a
 *   small bar unless the owner turned the bar off. The name shares the root domain's first path
 *   segment with Nap's own routes, which are reserved (RESERVED_SLUGS in uploads.ts) and always
 *   win.
 * - On its own host (kind "site"): <name>.<content>, where <content> is the deployment's content
 *   domain (napConfig.contentDomain, by default the root domain). Real origin, lasting storage,
 *   root-absolute paths work. An interim mode for the naps that need these, until frames get
 *   origins of their own.
 *
 * Local development has one host: naps on their own host are at /s/<name>/, the rest at /<name>.
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
  /** Where naps on their own host live: <name>.<contentDomain>. Unset means the root domain. */
  contentDomain?: string;
  /** The local dev origin (for example http://localhost:3000). Unset in production. */
  localOrigin?: string | null;
};

export function napUrl(nap: { slug: string; kind: NapKind }, place: NapPlace) {
  if (nap.kind === "artifact") {
    const origin = place.localOrigin || `https://${place.rootDomain}`;
    return `${origin}${artifactPath(nap.slug)}`;
  }
  if (place.localOrigin) return `${place.localOrigin}/s/${nap.slug}/`;
  return `https://${nap.slug}.${contentDomainOf(place)}/`;
}

/** The domain below which naps on their own host live. */
export function contentDomainOf(place: { rootDomain: string; contentDomain?: string }) {
  return place.contentDomain || place.rootDomain;
}

/** The deployment's domains, from its config, for browser code and labels. */
export const NAP_DOMAINS = {
  rootDomain: napConfig.rootDomain,
  contentDomain: napConfig.contentDomain || napConfig.rootDomain,
};

/** The URL without the scheme, for labels: elo.<content>, <root>/x. */
export function napLabel(
  nap: { slug: string; kind: NapKind },
  place: string | { rootDomain: string; contentDomain?: string } = NAP_DOMAINS,
) {
  const domains = typeof place === "string" ? { rootDomain: place } : place;
  return nap.kind === "artifact"
    ? `${domains.rootDomain}${artifactPath(nap.slug)}`
    : `${nap.slug}.${contentDomainOf(domains)}`;
}

export function isLocalHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** For browser code: the place of the current page. */
export function browserPlace(rootDomain = napConfig.rootDomain): NapPlace {
  const contentDomain = napConfig.contentDomain || undefined;
  if (typeof window === "undefined") return { rootDomain, contentDomain };
  const { hostname, origin } = window.location;
  if (isLocalHostname(hostname)) return { rootDomain, contentDomain, localOrigin: origin };
  return { rootDomain: hostname, contentDomain };
}
