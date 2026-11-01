import { Effect, Schema } from "effect";
import { canViewSite } from "~/lib/site-data";
import { MANIFEST_PATH, siteManifest } from "~/lib/site-manifest";
import { Database } from "~/server/database";
import { failNoStore, isCrossSite } from "~/server/http";
import { Settings } from "~/server/platform";

const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const CACHE_SECONDS = 300;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** The page's own headers for the upstream request, as a JSON object. */
const HEADERS_HEADER = "x-nap-fetch-headers";
/**
 * Headers a page may set on the upstream request. Never the viewer's cookies or Access headers:
 * Nap only sends what the page passes explicitly, and drops headers that would let a page
 * steer Cloudflare or pose as Nap.
 */
const BLOCKED_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);
const BLOCKED_PREFIXES = ["cf-", "x-forwarded-", "x-real-ip", "x-nap-", "proxy-", "sec-"];

/** The upstream fetch failed (DNS, connection, TLS). It becomes a 500, as before. */
export class UpstreamFetchError extends Schema.TaggedError<UpstreamFetchError>()(
  "UpstreamFetchError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/**
 * Fetches a URL for a page, so pages can use APIs that do not allow other origins. Only HTTPS,
 * only hosts the site lists in nap.json, and only for people who can view the site. Nothing of
 * the viewer's is sent on (no cookies, no Access headers, no referrer); only the method, body,
 * and headers the page passes. Plain GETs are cached at the edge for a few minutes.
 */
export const handleSiteFetch = Effect.fn("handleSiteFetch")(function* (
  slug: string,
  request: Request,
  email: string,
) {
  if (!METHODS.has(request.method)) {
    return yield* failNoStore(405, `${request.method} requests cannot be fetched`);
  }
  if (isCrossSite(request)) return yield* failNoStore(403, "Forbidden");
  const forwarded = readForwardedHeaders(request.headers.get(HEADERS_HEADER));
  if (typeof forwarded === "string") return yield* failNoStore(400, forwarded);

  const db = yield* Database;
  const site = yield* db.first<{ currentVersion: string | null; kind: string }>(
    `SELECT current_version AS currentVersion, kind FROM sites WHERE slug = ?`,
    slug,
  );
  if (!site?.currentVersion || site.kind !== "site") {
    return yield* failNoStore(404, "Site not found");
  }
  if (!(yield* canViewSite(slug, email))) return yield* failNoStore(403, "Forbidden");

  const requested = parseUrl(new URL(request.url).searchParams.get("url") ?? "");
  if (!requested) return yield* failNoStore(400, "Pass an absolute URL as ?url=");
  let target: URL = requested;
  let method = request.method;
  let body = yield* readBody(request);
  if (body === "too large") return yield* failNoStore(413, "The request body is too large");

  const { rootDomain } = yield* Settings;
  const hosts = (yield* siteManifest(slug, site.currentVersion)).fetch;
  for (let redirects = 0; ; redirects++) {
    const problem = checkTarget(target, hosts, rootDomain);
    if (problem) return yield* failNoStore(403, problem);

    const upstream = yield* fetchUpstream(target, request, method, forwarded, body);

    const location = upstream.headers.get("location");
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      if (redirects >= MAX_REDIRECTS) return yield* failNoStore(502, "Too many redirects");
      target = new URL(location, target);
      // As browsers do: 307 and 308 repeat the request, the others turn it into a GET.
      if (upstream.status !== 307 && upstream.status !== 308 && method !== "HEAD") {
        method = "GET";
        body = null;
      }
      continue;
    }

    const length = Number(upstream.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) return yield* failNoStore(502, "The response is too large");
    return new Response(upstream.body ? limit(upstream.body, MAX_BYTES) : null, {
      status: upstream.status,
      headers: proxiedHeaders(
        upstream.headers,
        target,
        upstream.ok && cacheable(method, forwarded),
      ),
    });
  }
});

/**
 * The page's headers from x-nap-fetch-headers, or a message saying what is wrong with them.
 * Headers Nap must control are dropped rather than refused, so a page can pass the headers it
 * would give fetch() without sorting them first.
 */
export function readForwardedHeaders(value: string | null): Record<string, string> | string {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return `${HEADERS_HEADER} must be a JSON object`;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `${HEADERS_HEADER} must be a JSON object`;
  }
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(parsed)) {
    const name = rawName.toLowerCase();
    if (typeof rawValue !== "string") return `The header ${rawName} must be a string`;
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return `${rawName} is not a header name`;
    if (BLOCKED_HEADERS.has(name) || BLOCKED_PREFIXES.some((p) => name.startsWith(p))) continue;
    headers[name] = rawValue;
  }
  return headers;
}

/** Only plain GETs are shared between viewers: the edge cache keys on the URL alone. */
function cacheable(method: string, forwarded: Record<string, string>) {
  const own = Object.keys(forwarded).filter(
    (name) => name !== "accept" && name !== "accept-language",
  );
  return (method === "GET" || method === "HEAD") && own.length === 0;
}

const readBody = Effect.fnUntraced(function* (request: Request) {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return null;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_REQUEST_BYTES) return "too large" as const;
  const bytes = yield* Effect.promise(() => request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) return "too large" as const;
  return bytes;
});

/** Nothing of the viewer's is sent on; only what the page passed. */
function fetchUpstream(
  target: URL,
  request: Request,
  method: string,
  forwarded: Record<string, string>,
  body: ArrayBuffer | null,
) {
  const headers: Record<string, string> = {
    accept: request.headers.get("accept") ?? "*/*",
    "accept-language": request.headers.get("accept-language") ?? "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (compatible; Nap/1.0)",
    ...forwarded,
  };
  if (body && !("content-type" in forwarded)) {
    const type = request.headers.get("content-type");
    if (type) headers["content-type"] = type;
  }
  const cache = cacheable(method, forwarded);
  return Effect.tryPromise({
    try: () =>
      fetch(target.toString(), {
        method,
        redirect: "manual",
        headers,
        body,
        // Without cacheEverything, the edge keeps none of these responses.
        ...(cache
          ? {
              cf: {
                cacheEverything: true,
                cacheTtlByStatus: { "200-299": CACHE_SECONDS, "300-599": 0 },
              },
            }
          : {}),
      }),
    catch: (cause) =>
      new UpstreamFetchError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
}

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function checkTarget(target: URL, hosts: string[], rootDomain: string) {
  if (target.protocol !== "https:") return "Only https URLs can be fetched";
  if (target.username || target.password) return "URLs with credentials cannot be fetched";
  if (target.port && target.port !== "443") return "Only the default https port can be fetched";
  const host = target.hostname.toLowerCase();
  if (host === rootDomain || host.endsWith(`.${rootDomain}`)) {
    return "Nap's own hosts cannot be fetched";
  }
  if (!hosts.some((allowed) => hostMatches(host, allowed))) {
    return `${host} is not in this site's ${MANIFEST_PATH} fetch list`;
  }
  return null;
}

function hostMatches(host: string, allowed: string) {
  if (allowed.startsWith("*.")) return host.endsWith(allowed.slice(1));
  return host === allowed;
}

/**
 * Keeps what a page needs to read the body. The response is served from the site's own origin,
 * so it is sandboxed: fetched HTML must never run as one of the site's pages.
 */
function proxiedHeaders(upstream: Headers, target: URL, cache: boolean) {
  const headers = new Headers();
  for (const name of ["content-type", "content-language", "last-modified", "etag"]) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", cache ? `private, max-age=${CACHE_SECONDS}` : "no-store");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-nap-fetch", "upstream");
  headers.set("x-nap-fetch-url", target.toString());
  return headers;
}

function limit(body: ReadableStream<Uint8Array>, maxBytes: number) {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new Error("The response is too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
