import { Effect, Schema } from "effect";
import type { Identity } from "~/lib/nap-server";
import { canViewSite } from "~/lib/site-data";
import { failNoStore, json, noStore } from "~/server/http";
import { Settings, type TurnKey } from "~/server/platform";

/** How long TURN credentials last. Pages ask again before they expire (nap.voice does). */
const TTL_SECONDS = 4 * 60 * 60;
/** A slow TURN API must not hold up joining a call: without credentials, pages use STUN. */
const TURN_TIMEOUT = "5 seconds";
export const STUN_ONLY = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

export type IceServer = {
  urls: string | ReadonlyArray<string>;
  username?: string;
  credential?: string;
};

const IceServers = Schema.Struct({
  iceServers: Schema.Array(
    Schema.Struct({
      urls: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
      username: Schema.optional(Schema.String),
      credential: Schema.optional(Schema.String),
    }),
  ),
});

/** Cloudflare's TURN API failed, answered something else, or took too long. */
export class TurnError extends Schema.TaggedError<TurnError>()("TurnError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * GET /_nap/rtc: ICE servers for WebRTC between the people on a nap, as
 * `new RTCPeerConnection({ iceServers })` takes them. With a TURN key, they include short-lived
 * Cloudflare TURN credentials, so calls connect on networks that block direct connections.
 * The TURN key itself never leaves the Worker.
 */
export const handleRtcRequest = Effect.fn("handleRtcRequest")(function* (
  slug: string,
  request: Request,
  identity: Identity,
) {
  if (request.method !== "GET") return yield* failNoStore(405, "Method not allowed");
  if (!(yield* canViewSite(slug, identity.email))) {
    return yield* failNoStore(404, "Site not found");
  }
  const { turn } = yield* Settings;
  const servers = turn
    ? yield* turnServers(turn).pipe(
        Effect.catchTag("TurnError", (error) =>
          Effect.logError("TURN credentials failed", error).pipe(Effect.as(null)),
        ),
      )
    : null;
  return json(
    servers
      ? {
          iceServers: servers,
          turn: true,
          expiresAt: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
        }
      : { iceServers: STUN_ONLY, turn: false, expiresAt: null },
    { headers: noStore },
  );
});

/** Short-lived TURN credentials from Cloudflare Realtime, as ICE servers. */
export const turnServers = Effect.fn("turnServers")(function* (key: TurnKey) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(key.keyId)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
          body: JSON.stringify({ ttl: TTL_SECONDS }),
          signal,
        },
      ),
    catch: (cause) => new TurnError({ message: "The TURN API could not be reached", cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: TURN_TIMEOUT,
      orElse: () => Effect.fail(new TurnError({ message: "The TURN API timed out" })),
    }),
  );
  if (!response.ok) {
    return yield* new TurnError({ message: `The TURN API answered ${response.status}` });
  }
  const body = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new TurnError({ message: "The TURN API answered no JSON", cause }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(IceServers)),
    Effect.mapError((cause) =>
      cause instanceof TurnError
        ? cause
        : new TurnError({ message: "The TURN API answered no ICE servers", cause }),
    ),
  );
  return usableServers(body.iceServers);
});

/**
 * Drops URLs on port 53, which browsers block: waiting for them to time out only slows a call
 * down. Null when nothing is left.
 */
export function usableServers(servers: ReadonlyArray<IceServer>): Array<IceServer> | null {
  const usable = servers
    .map((server) => ({
      ...server,
      urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
        (url: string) => !/:53(\?|$)/.test(url),
      ),
    }))
    .filter((server) => server.urls.length > 0);
  return usable.length ? usable : null;
}
