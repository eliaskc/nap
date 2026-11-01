import { json } from "~/lib/nap-server";
import { canViewSite } from "~/lib/site-data";
import { isCrossSite } from "~/lib/site-access";
import { MANIFEST_PATH, siteManifest } from "~/lib/site-manifest";

type SiteFetchEnv = {
  DB: D1Database;
  SITES: R2Bucket;
};

const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const CACHE_SECONDS = 300;

/**
 * Fetches a public URL for a page, so pages can read APIs that do not allow other origins. Only
 * GET, only HTTPS, only hosts the site lists in nap.json, and only for people who can view the
 * site. Nothing of the viewer's is sent on: no cookies, no Access headers, no referrer.
 */
export async function handleSiteFetch(
  env: SiteFetchEnv,
  slug: string,
  request: Request,
  email: string,
  rootDomain: string,
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return napError("Only GET requests can be fetched", 405);
  }
  if (isCrossSite(request)) return napError("Forbidden", 403);

  const site = await env.DB.prepare(
    `SELECT current_version AS currentVersion, kind FROM sites WHERE slug = ?`,
  )
    .bind(slug)
    .first<{ currentVersion: string | null; kind: string }>();
  if (!site?.currentVersion || site.kind !== "site") return napError("Site not found", 404);
  if (!(await canViewSite(env.DB, slug, email))) return napError("Forbidden", 403);

  let target: URL;
  try {
    target = new URL(new URL(request.url).searchParams.get("url") ?? "");
  } catch {
    return napError("Pass an absolute URL as ?url=", 400);
  }

  const hosts = (await siteManifest(env.SITES, slug, site.currentVersion)).fetch;
  for (let redirects = 0; ; redirects++) {
    const problem = checkTarget(target, hosts, rootDomain);
    if (problem) return napError(problem, 403);

    const upstream = await fetch(target.toString(), {
      method: request.method,
      redirect: "manual",
      headers: {
        accept: request.headers.get("accept") ?? "*/*",
        "accept-language": request.headers.get("accept-language") ?? "en-US,en;q=0.9",
        "user-agent": "Mozilla/5.0 (compatible; Nap/1.0)",
      },
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": CACHE_SECONDS, "300-599": 0 } },
    });

    const location = upstream.headers.get("location");
    if (upstream.status >= 300 && upstream.status < 400 && location) {
      if (redirects >= MAX_REDIRECTS) return napError("Too many redirects", 502);
      target = new URL(location, target);
      continue;
    }

    const length = Number(upstream.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) return napError("The response is too large", 502);
    return new Response(upstream.body ? limit(upstream.body, MAX_BYTES) : null, {
      status: upstream.status,
      headers: proxiedHeaders(upstream.headers, target),
    });
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
function proxiedHeaders(upstream: Headers, target: URL) {
  const headers = new Headers();
  for (const name of ["content-type", "content-language", "last-modified", "etag"]) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", `private, max-age=${CACHE_SECONDS}`);
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

function napError(error: string, status: number) {
  return json({ error }, { status, headers: { "cache-control": "no-store" } });
}
