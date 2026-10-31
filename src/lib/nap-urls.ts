/**
 * Where a nap lives. One rule:
 *
 * - A site (a nap with a chosen URL) has its own host: <slug>.<root>. Real origin, real
 *   localStorage, root-absolute paths work.
 * - An artifact is at <root>/artifact/<slug>. Nap shows it in a sandboxed frame below a small bar.
 *
 * Local development has one host: sites are at /s/<slug>/ and artifacts at /artifact/<slug>.
 * The functions here run on the server and in the browser.
 */

import { napConfig } from "~/nap.config";

export type NapKind = "site" | "artifact";

export const ARTIFACT_PATH = "/artifact";

export type NapPlace = {
  rootDomain: string;
  /** The local dev origin (for example http://localhost:3000). Unset in production. */
  localOrigin?: string | null;
};

export function napUrl(nap: { slug: string; kind: NapKind }, place: NapPlace) {
  if (nap.kind === "artifact") {
    const origin = place.localOrigin || `https://${place.rootDomain}`;
    return `${origin}${ARTIFACT_PATH}/${nap.slug}`;
  }
  if (place.localOrigin) return `${place.localOrigin}/s/${nap.slug}/`;
  return `https://${nap.slug}.${place.rootDomain}/`;
}

/** The URL without the scheme, for labels: elo.<root>, <root>/artifact/x. */
export function napLabel(nap: { slug: string; kind: NapKind }, rootDomain: string) {
  return nap.kind === "artifact"
    ? `${rootDomain}${ARTIFACT_PATH}/${nap.slug}`
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
