import { NapError } from "./errors";

/**
 * The URL of a Nap endpoint for this page: /_nap/<suffix> on a site, below /_nap/frame/<token>/
 * in an artifact, and below /s/<slug>/ on a local dev server.
 */
export function napPath(suffix: string) {
  // An artifact: its files are below /_nap/frame/<token>/, and so is its data.
  const frame = location.pathname.match(/^\/_nap\/frame\/([A-Za-z0-9_-]+)\//);
  if (frame) return "/_nap/frame/" + frame[1] + "/_nap/" + suffix;
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (!local) return "/_nap/" + suffix;
  const match = location.pathname.match(/^\/s\/([^/]+)(?:\/|$)/);
  if (!match) throw new NapError("Nap site data is unavailable outside a site", 400);
  return "/s/" + encodeURIComponent(match[1]) + "/_nap/" + suffix;
}

/** The same endpoint as a WebSocket URL. */
export function napSocketUrl(suffix: string) {
  const url = new URL(napPath(suffix), location.href);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.href;
}

/** Fetches a Nap endpoint and reads its JSON, throwing a NapError for error statuses. */
export async function napJson<T>(suffix: string, init?: RequestInit): Promise<T> {
  const response = await fetch(napPath(suffix), init);
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new NapError(result.error || "Nap request failed", response.status);
  return result as T;
}

/** Calls each listener, so one throwing listener cannot stop the others. */
export function emitTo<T>(listeners: Iterable<(value: T) => void>, value: T) {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      console.error(error);
    }
  }
}

/** Exponential backoff with jitter: about base * 2^attempt, at most max. */
export function backoff(attempt: number, base: number, max: number) {
  return Math.min(max, base * 2 ** attempt) * (0.5 + Math.random() / 2);
}
