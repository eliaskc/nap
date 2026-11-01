import type { NapFetchOptions } from "./api";
import { NapError } from "./errors";
import { napPath } from "./paths";

/**
 * Fetches a URL through Nap, for APIs that do not allow other origins. The site lists the hosts
 * in nap.json: { "fetch": ["api.example.com", "*.example.org"] }. The page's headers travel in
 * x-nap-fetch-headers, so Nap can tell them apart from the browser's own and never pass the
 * viewer's cookies or login on.
 */
export async function proxyFetch(url: string | URL, options: NapFetchOptions = {}) {
  const target = new URL(url, location.href).toString();
  const own: Record<string, string> = {};
  new Headers(options.headers).forEach((value, name) => {
    own[name] = value;
  });
  const headers: Record<string, string> = {};
  if (Object.keys(own).length) headers["x-nap-fetch-headers"] = JSON.stringify(own);
  if (own["content-type"]) headers["content-type"] = own["content-type"];
  const response = await fetch(napPath("fetch?url=" + encodeURIComponent(target)), {
    method: options.method || "GET",
    headers,
    body: options.body,
    signal: options.signal,
  });
  if (!response.headers.get("x-nap-fetch")) {
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    throw new NapError(result.error || "Nap fetch failed", response.status);
  }
  return response;
}
