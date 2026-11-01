import type { NapFetchOptions } from "./api";
import { NapError } from "./errors";
import { napPath } from "./paths";

/**
 * Reads a public URL through Nap, for APIs that do not allow other origins. The site lists the
 * hosts in nap.json: { "fetch": ["api.example.com", "*.example.org"] }.
 */
export async function proxyFetch(url: string | URL, options: NapFetchOptions = {}) {
  const target = new URL(url, location.href).toString();
  const response = await fetch(napPath("fetch?url=" + encodeURIComponent(target)), {
    method: options.method || "GET",
    headers: options.headers,
    signal: options.signal,
  });
  if (!response.headers.get("x-nap-fetch")) {
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    throw new NapError(result.error || "Nap fetch failed", response.status);
  }
  return response;
}
