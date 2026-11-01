import { objectKey } from "~/lib/nap-server";

/** The file in a site's live version that sets what Nap does for it. */
export const MANIFEST_PATH = "nap.json";
const MAX_HOSTS = 20;
const HOST_PATTERN = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export type SiteManifest = {
  /** Hosts its pages may fetch through Nap: "api.example.com", "*.example.org". */
  fetch: string[];
  /** A single-page app: paths without a file serve the root index.html. */
  spa: boolean;
};

const EMPTY: SiteManifest = { fetch: [], spa: false };

/** Manifests per site version. Versions are immutable, so an entry never goes stale. */
const byVersion = new Map<string, SiteManifest>();

/** Reads nap.json from a version. A missing or broken file means the defaults. */
export async function siteManifest(sites: R2Bucket, slug: string, version: string) {
  const key = `${slug}/${version}`;
  const cached = byVersion.get(key);
  if (cached) return cached;

  let manifest = EMPTY;
  const object = await sites.get(objectKey(slug, version, MANIFEST_PATH));
  if (object) {
    try {
      manifest = parseManifest(await object.json());
    } catch {
      manifest = EMPTY;
    }
  }
  if (byVersion.size > 500) byVersion.clear();
  byVersion.set(key, manifest);
  return manifest;
}

export function parseManifest(value: unknown): SiteManifest {
  if (!value || typeof value !== "object") return EMPTY;
  const raw = value as { fetch?: unknown; spa?: unknown };
  const fetch = Array.isArray(raw.fetch)
    ? raw.fetch
        .filter((host): host is string => typeof host === "string")
        .map((host) => host.trim().toLowerCase())
        .filter((host) => HOST_PATTERN.test(host))
        .slice(0, MAX_HOSTS)
    : [];
  return { fetch, spa: raw.spa === true };
}
