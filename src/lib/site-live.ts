import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import type { Identity } from "~/lib/nap-server";
import { canViewSite, viewersAmong } from "~/lib/site-data";
import { LiveBinding } from "~/server/bindings";
import { Database } from "~/server/database";
import { fail } from "~/server/http";
import { inBackground } from "~/server/platform";

const MAX_SOCKETS = 1000;

type LiveEnv = {
  DB: D1Database;
};

/** expiresAt: for artifact frames, when the frame token expires. */
type Attachment = { email: string; expiresAt?: string };

/**
 * Live collection updates for one site, named by its slug. D1 stays the only store: the Worker
 * writes there, then hands the change to this object, which sends it to every open page.
 * The object keeps nothing but hibernating WebSockets.
 */
export class SiteLive extends DurableObject<LiveEnv> {
  constructor(ctx: DurableObjectState, env: LiveEnv) {
    super(ctx, env);
    // Keep-alive pings get answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** The Worker checked access and set x-nap-email. Nothing else reaches this object. */
  async fetch(request: Request) {
    const email = request.headers.get("x-nap-email");
    if (!email) return new Response("Forbidden", { status: 403 });
    const expiresAt = request.headers.get("x-nap-expires-at") ?? undefined;
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response("Too many connections", { status: 429 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ email, expiresAt } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Sends a change to every page. Access can change while a page is open, so each send checks
   * who may still see the site and closes the sockets of everyone else.
   */
  async broadcast(slug: string, message: string) {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const attachment = (socket: WebSocket) =>
      (socket.deserializeAttachment() as Attachment | null) ?? { email: "" };
    const emails = [...new Set(sockets.map((socket) => attachment(socket).email))];
    const allowed = await Effect.runPromise(
      viewersAmong(slug, emails).pipe(Effect.provideService(Database, Database.make(this.env.DB))),
    );
    const now = new Date().toISOString();
    for (const socket of sockets) {
      const { email, expiresAt } = attachment(socket);
      try {
        if (expiresAt && expiresAt <= now) socket.close(4401, "Frame token expired");
        else if (allowed.has(email.toLowerCase())) socket.send(message);
        else socket.close(4403, "Access changed");
      } catch {
        // Already closing.
      }
    }
  }

  async webSocketMessage() {
    // Pages only listen. Pings are answered by the auto-response.
  }

  async webSocketClose(socket: WebSocket, code: number) {
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "Closed");
    } catch {
      // Already closed.
    }
  }
}

/**
 * GET /_nap/live with a WebSocket upgrade. For artifact frames, `identity` comes from the frame
 * token: Access does not protect that path, so its headers say nothing.
 */
export const handleLiveRequest = Effect.fn("handleLiveRequest")(function* (
  slug: string,
  request: Request,
  identity: Identity,
  expiresAt?: string,
) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return yield* fail(426, "Expected a WebSocket upgrade");
  }
  const live = yield* LiveBinding;
  if (!live) return yield* fail(503, "Live updates are unavailable");
  if (!(yield* canViewSite(slug, identity.email))) return yield* fail(404, "Site not found");
  const headers = new Headers({ upgrade: "websocket", "x-nap-email": identity.email });
  if (expiresAt) headers.set("x-nap-expires-at", expiresAt);
  return yield* Effect.promise(() => live.getByName(slug).fetch("https://live/", { headers }));
});

/** Hands a committed change to the site's live object. Pages poll if this ever fails. */
export const publishChange = Effect.fnUntraced(function* (
  slug: string,
  collection: string,
  change: unknown,
) {
  const live = yield* LiveBinding;
  if (!live) return;
  const message = JSON.stringify({ type: "change", collection, change });
  yield* inBackground(
    Effect.tryPromise(() => live.getByName(slug).broadcast(slug, message)),
    "Live broadcast failed",
  ).pipe(Effect.annotateLogs({ slug }));
});
