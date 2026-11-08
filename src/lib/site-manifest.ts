import { Effect, Predicate } from "effect";
import { objectKey } from "~/lib/nap-server";
import { Storage } from "~/server/storage";

/** The file in a site's live version that sets what Nap does for it. */
export const MANIFEST_PATH = "nap.json";
const MAX_HOSTS = 20;
const HOST_PATTERN = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const MAX_DATA_SITES = 20;
const MAX_DATA_COLLECTIONS = 20;
const MAX_SERVERS = 20;
/** A channel name, with `*` for any run of characters: "game-*", "lobby", "*". */
const SERVER_PATTERN = /^[A-Za-z0-9_*-]{1,64}$/;
/** A JavaScript file in the upload: "server.js", "server/game.mjs". */
const SERVER_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,200}\.m?js$/;
export const SLUG_PATTERN = /^[a-z0-9-]{1,32}$/;
export const COLLECTION_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;

export type SiteManifest = {
  /** Hosts its pages may fetch through Nap: "api.example.com", "*.example.org". */
  fetch: string[];
  /** A single-page app: paths without a file serve the root index.html. */
  spa: boolean;
  /** Other sites whose pages may use its collections: source slug -> collection names. */
  data: { allow: Record<string, string[]> };
  /**
   * Channel servers: channel name pattern -> the JavaScript file in the upload that runs for
   * those channels on Nap (see site-channel.ts). The first matching pattern wins.
   */
  servers: Array<{ channels: string; path: string }>;
};

const EMPTY: SiteManifest = { fetch: [], spa: false, data: { allow: {} }, servers: [] };

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
  const raw = value as { fetch?: unknown; spa?: unknown; data?: unknown; servers?: unknown };
  const fetch = Array.isArray(raw.fetch)
    ? raw.fetch
        .filter(Predicate.isString)
        .map((host) => host.trim().toLowerCase())
        .filter((host) => HOST_PATTERN.test(host))
        .slice(0, MAX_HOSTS)
    : [];
  return {
    fetch,
    spa: raw.spa === true,
    data: { allow: parseDataAllow(raw.data) },
    servers: parseServers(raw.servers),
  };
}

/** `{ "<channel pattern>": "<path>" }`, keeping only valid patterns and paths. */
function parseServers(servers: unknown) {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.entries(servers)
    .filter(
      (entry): entry is [string, string] =>
        SERVER_PATTERN.test(entry[0]) &&
        typeof entry[1] === "string" &&
        SERVER_PATH.test(entry[1].replace(/^\/+/, "")),
    )
    .slice(0, MAX_SERVERS)
    .map(([channels, path]) => ({ channels, path: path.replace(/^\/+/, "") }));
}

/** The server file that runs for `channel`, if the manifest names one. */
export function serverFor(manifest: SiteManifest, channel: string) {
  return manifest.servers.find(({ channels }) => matchesPattern(channels, channel))?.path ?? null;
}

/** SERVER_PATTERN allows no regex characters but `*`. */
function matchesPattern(pattern: string, name: string) {
  return new RegExp(`^${pattern.replaceAll("*", ".*")}$`).test(name);
}

/** `{ "allow": { "<site>": ["<collection>", ...] } }`, keeping only valid names. */
function parseDataAllow(data: unknown) {
  const allow: Record<string, string[]> = {};
  const raw = data && typeof data === "object" ? (data as { allow?: unknown }).allow : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return allow;
  for (const [slug, names] of Object.entries(raw).slice(0, MAX_DATA_SITES)) {
    if (!SLUG_PATTERN.test(slug) || !Array.isArray(names)) continue;
    const collections = [
      ...new Set(names.filter(Predicate.isString).filter((name) => COLLECTION_PATTERN.test(name))),
    ].slice(0, MAX_DATA_COLLECTIONS);
    if (collections.length) allow[slug] = collections;
  }
  return allow;
}
