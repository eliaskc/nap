import { findPerson } from "~/lib/profiles";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import type { Identity } from "~/lib/nap-server";
import { canViewSite, viewersAmong } from "~/lib/site-data";
import { ChannelsBinding } from "~/server/bindings";
import { Database } from "~/server/database";
import { fail } from "~/server/http";

export const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_PEERS = 200;
const MAX_MESSAGE_CHARS = 16 * 1024;
const MAX_PRESENCE_CHARS = 1024;
const MESSAGES_PER_SECOND = 40;
const ACCESS_CHECK_MS = 60_000;

type ChannelEnv = {
  DB: D1Database;
};

/**
 * One connection. Kept as the socket's attachment (at most 2 KiB), so it survives hibernation.
 * expiresAt: for artifact frames, when the frame token expires.
 */
type Peer = {
  id: string;
  email: string;
  name: string;
  shape: string;
  color: string;
  slug: string;
  joinedAt: number;
  state: unknown;
  expiresAt?: string;
};

type ClientMessage =
  | { t: "presence"; state?: unknown }
  | { t: "send"; data?: unknown; to?: unknown };

/**
 * A channel: one Durable Object per site and channel name, for multiplayer pages. Pages send
 * messages to each other and keep a small presence state each. Nothing is stored: the object
 * holds hibernating WebSockets, and each socket's attachment holds its presence. The object
 * stamps every message with the sender, so pages cannot speak for someone else.
 */
export class SiteChannel extends DurableObject<ChannelEnv> {
  private rates = new Map<WebSocket, { second: number; count: number }>();
  private lastAccessCheck = 0;

  constructor(ctx: DurableObjectState, env: ChannelEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** The Worker checked access and set the x-nap-* headers. Nothing else reaches this object. */
  async fetch(request: Request) {
    const email = request.headers.get("x-nap-email");
    const slug = request.headers.get("x-nap-slug");
    if (!email || !slug) return new Response("Forbidden", { status: 403 });
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PEERS) return new Response("Channel is full", { status: 429 });

    const peer: Peer = {
      id: crypto.randomUUID().replaceAll("-", "").slice(0, 12),
      email,
      name: safeDecode(request.headers.get("x-nap-name") ?? email).slice(0, 80),
      shape: request.headers.get("x-nap-shape") ?? "",
      color: request.headers.get("x-nap-color") ?? "",
      slug,
      joinedAt: Date.now(),
      state: null,
      expiresAt: request.headers.get("x-nap-expires-at") ?? undefined,
    };
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(peer);

    const others = sockets.map(peerOf).filter((other): other is Peer => other !== null);
    server.send(
      JSON.stringify({ t: "welcome", id: peer.id, peers: [...others, peer].map(publicPeer) }),
    );
    this.broadcast({ t: "join", peer: publicPeer(peer) }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const peer = peerOf(socket);
    if (!peer) return;
    if (typeof message !== "string") return sendError(socket, "Messages must be JSON text");
    if (message.length > MAX_MESSAGE_CHARS) return sendError(socket, "Message exceeds 16 KB");
    if (!this.allow(socket)) return;
    if (!(await this.checkAccess(socket))) return;

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      return sendError(socket, "Invalid JSON");
    }

    if (parsed?.t === "presence") {
      const state = parsed.state ?? null;
      if (JSON.stringify(state).length > MAX_PRESENCE_CHARS) {
        return sendError(socket, "Presence exceeds 1 KB");
      }
      socket.serializeAttachment({ ...peer, state } satisfies Peer);
      this.broadcast({ t: "presence", id: peer.id, state }, socket);
      return;
    }
    if (parsed?.t === "send") {
      const out = {
        t: "message",
        from: {
          id: peer.id,
          email: peer.email,
          name: peer.name,
          shape: peer.shape,
          color: peer.color,
        },
        data: parsed.data ?? null,
      };
      if (typeof parsed.to === "string") {
        const target = this.ctx.getWebSockets().find((s) => peerOf(s)?.id === parsed.to);
        if (target) trySend(target, JSON.stringify(out));
        return;
      }
      this.broadcast(out, socket);
      return;
    }
    sendError(socket, "Unknown message type");
  }

  async webSocketClose(socket: WebSocket, code: number) {
    this.depart(socket, code === 1005 || code === 1006 ? 1000 : code, "Closed");
  }

  async webSocketError(socket: WebSocket) {
    this.depart(socket, 1011, "Error");
  }

  private depart(socket: WebSocket, code: number, reason: string) {
    const peer = peerOf(socket);
    this.rates.delete(socket);
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
    if (peer) this.broadcast({ t: "leave", id: peer.id }, socket);
  }

  /** Sends to every socket but `except`. */
  private broadcast(message: unknown, except?: WebSocket) {
    const text = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except) trySend(socket, text);
    }
  }

  /** Drops messages over the rate limit, and says so once a second. */
  private allow(socket: WebSocket) {
    const second = Math.floor(Date.now() / 1000);
    const rate = this.rates.get(socket);
    if (!rate || rate.second !== second) {
      this.rates.set(socket, { second, count: 1 });
      return true;
    }
    rate.count++;
    if (rate.count === MESSAGES_PER_SECOND + 1) {
      sendError(socket, `Over ${MESSAGES_PER_SECOND} messages a second; some were dropped`);
    }
    return rate.count <= MESSAGES_PER_SECOND;
  }

  /**
   * Access can change while a channel is open. At most once a minute, while messages flow,
   * close the sockets of people who lost access or whose artifact view expired. Returns whether
   * `current` may still send.
   */
  private async checkAccess(current: WebSocket) {
    const now = Date.now();
    if (now - this.lastAccessCheck < ACCESS_CHECK_MS) return true;
    this.lastAccessCheck = now;
    const sockets = this.ctx.getWebSockets();
    const peers = sockets.map(peerOf);
    const slug = peers.find(Boolean)?.slug;
    if (!slug) return true;
    const emails = [...new Set(peers.map((peer) => peer?.email ?? ""))];
    const allowed = await Effect.runPromise(
      viewersAmong(slug, emails).pipe(Effect.provideService(Database, Database.make(this.env.DB))),
    );
    const iso = new Date(now).toISOString();
    let currentAllowed = true;
    sockets.forEach((socket, index) => {
      const peer = peers[index];
      if (!peer) return;
      const expired = peer.expiresAt && peer.expiresAt <= iso;
      if (!expired && allowed.has(peer.email.toLowerCase())) return;
      if (socket === current) currentAllowed = false;
      this.depart(
        socket,
        expired ? 4401 : 4403,
        expired ? "Frame token expired" : "Access changed",
      );
    });
    return currentAllowed;
  }
}

function peerOf(socket: WebSocket) {
  return (socket.deserializeAttachment() as Peer | null) ?? null;
}

function publicPeer(peer: Peer) {
  return {
    id: peer.id,
    email: peer.email,
    name: peer.name,
    shape: peer.shape,
    color: peer.color,
    joinedAt: peer.joinedAt,
    state: peer.state,
  };
}

function trySend(socket: WebSocket, text: string) {
  try {
    socket.send(text);
  } catch {
    // Closing.
  }
}

function sendError(socket: WebSocket, error: string) {
  trySend(socket, JSON.stringify({ t: "error", error }));
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * GET /_nap/channel/<name> with a WebSocket upgrade. For artifact frames, `identity` comes from
 * the frame token: Access does not protect that path, so its headers say nothing.
 */
export const handleChannelRequest = Effect.fn("handleChannelRequest")(function* (
  slug: string,
  name: string,
  request: Request,
  identity: Identity,
  expiresAt?: string,
) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return yield* fail(426, "Expected a WebSocket upgrade");
  }
  if (!CHANNEL_PATTERN.test(name)) {
    return yield* fail(
      400,
      "Channel names are up to 64 letters, numbers, _ or -, starting with a letter or number",
    );
  }
  const channels = yield* ChannelsBinding;
  if (!channels) return yield* fail(503, "Channels are unavailable");
  if (!(yield* canViewSite(slug, identity.email))) return yield* fail(404, "Site not found");
  const person = yield* findPerson(identity.email, identity.name);
  const headers = new Headers({
    upgrade: "websocket",
    "x-nap-email": identity.email,
    "x-nap-name": encodeURIComponent(person.name || identity.email),
    "x-nap-shape": person.shape,
    "x-nap-color": person.color,
    "x-nap-slug": slug,
  });
  if (expiresAt) headers.set("x-nap-expires-at", expiresAt);
  return yield* Effect.promise(() =>
    channels.getByName(`${slug}/${name}`).fetch("https://channel/", { headers }),
  );
});
