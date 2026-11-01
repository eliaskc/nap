import { Effect, Predicate } from "effect";
import { objectKey } from "~/lib/nap-server";
import { Storage } from "~/server/storage";

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
export const siteManifest = Effect.fnUntraced(function* (slug: string, version: string) {
  const key = `${slug}/${version}`;
  const cached = byVersion.get(key);
  if (cached) return cached;

  const storage = yield* Storage;
  const object = yield* storage.get(objectKey(slug, version, MANIFEST_PATH));
  const manifest = object
    ? parseManifest(yield* Effect.promise(() => object.json().catch(() => null)))
    : EMPTY;
  if (byVersion.size > 500) byVersion.clear();
  byVersion.set(key, manifest);
  return manifest;
});

export function parseManifest(value: unknown): SiteManifest {
  if (!value || typeof value !== "object") return EMPTY;
  const raw = value as { fetch?: unknown; spa?: unknown };
  const fetch = Array.isArray(raw.fetch)
    ? raw.fetch
        .filter(Predicate.isString)
        .map((host) => host.trim().toLowerCase())
        .filter((host) => HOST_PATTERN.test(host))
        .slice(0, MAX_HOSTS)
    : [];
  return { fetch, spa: raw.spa === true };
}
