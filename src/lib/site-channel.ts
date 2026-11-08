import { findPerson } from "~/lib/profiles";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import {
  ChannelServerRunner,
  SERVER_PEER,
  type ServerCode,
  type ServerMessage,
} from "~/lib/channel-server";
import type { Identity } from "~/lib/nap-server";
import { canViewSite, viewersAmong } from "~/lib/site-data";
import { serverFor, siteManifest } from "~/lib/site-manifest";
import { ChannelsBinding } from "~/server/bindings";
import { Database } from "~/server/database";
import { fail } from "~/server/http";

export const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_PEERS = 200;
const MAX_MESSAGE_CHARS = 16 * 1024;
const MAX_PRESENCE_CHARS = 1024;
const MESSAGES_PER_SECOND = 40;
const ACCESS_CHECK_MS = 60_000;
const MAX_SERVER_MESSAGE_CHARS = 256 * 1024;
const SERVER_ERROR_EVERY_MS = 1000;

type ChannelEnv = {
  DB: D1Database;
  SITES?: R2Bucket;
  LOADER?: WorkerLoader;
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
  /** A watcher sees the peers and their presence but is not one: no join, no presence, no messages. */
  watch?: boolean;
  /** The channel's name. */
  channel?: string;
  /** The site's live version when the peer joined, and the server file it runs for the channel. */
  version?: string;
  server?: string;
};

type ClientMessage =
  | { t: "presence"; state?: unknown }
  | { t: "send"; data?: unknown; to?: unknown };

/**
 * A channel: one Durable Object per site and channel name, for multiplayer pages. Pages send
 * messages to each other and keep a small presence state each. Nothing is stored: the object
 * holds hibernating WebSockets, and each socket's attachment holds its presence. The object
 * stamps every message with the sender, so pages cannot speak for someone else.
 *
 * A site may also run its own server for the channel (channel-server.ts). Pages then send it
 * messages with `to: "server"`, and it answers from the peer id "server".
 */
export class SiteChannel extends DurableObject<ChannelEnv> {
  private rates = new Map<WebSocket, { second: number; count: number }>();
  private lastAccessCheck = 0;
  private server: ChannelServerRunner;
  private lastServerError = 0;

  constructor(ctx: DurableObjectState, env: ChannelEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.server = new ChannelServerRunner(ctx, env, {
      peers: () => this.peers().map(serverPeer),
      deliver: (messages) => this.deliver(messages),
      report: (error, to) => this.reportServerError(error, to),
    });
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
      watch: request.headers.get("x-nap-watch") === "1" || undefined,
      channel: request.headers.get("x-nap-channel") ?? undefined,
      version: request.headers.get("x-nap-version") ?? undefined,
      server: request.headers.get("x-nap-server") ?? undefined,
    };
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(peer);

    const others = sockets
      .map(peerOf)
      .filter((other): other is Peer => other !== null && !other.watch);
    const peers = peer.watch ? others : [...others, peer];
    const hasServer = this.server.running || (Boolean(peer.server) && this.server.enabled);
    server.send(
      JSON.stringify({
        t: "welcome",
        id: peer.id,
        peers: peers.map(publicPeer),
        server: hasServer,
      }),
    );
    if (!peer.watch) {
      this.broadcast({ t: "join", peer: publicPeer(peer) }, server);
      this.server.joined(serverPeer(peer), serverCode(peer));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const peer = peerOf(socket);
    if (!peer) return;
    if (typeof message !== "string") return sendError(socket, "Messages must be JSON text");
    if (message.length > MAX_MESSAGE_CHARS) return sendError(socket, "Message exceeds 16 KB");
    if (!this.allow(socket)) return;
    if (!(await this.checkAccess(socket))) return;
    if (peer.watch) return sendError(socket, "Watching: this connection cannot send");

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
      if (this.server.running) this.server.presence(peer.id, state);
      return;
    }
    if (parsed?.t === "send" && parsed.to === SERVER_PEER.id) {
      const code = serverCode(peer);
      if (!this.server.running && !code) return sendError(socket, "This channel has no server");
      this.server.message(peer.id, parsed.data ?? null, code);
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
        const target = this.ctx
          .getWebSockets()
          .find((s) => peerOf(s)?.id === parsed.to && !peerOf(s)?.watch);
        if (target) trySend(target, JSON.stringify(out));
        return;
      }
      // Messages go to peers only: watchers get who is here, not the traffic.
      this.broadcast(out, socket, true);
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
    if (!peer || peer.watch) return;
    this.broadcast({ t: "leave", id: peer.id }, socket);
    const remaining = this.peers().filter((other) => other.id !== peer.id).length;
    this.server.left(peer.id, remaining);
  }

  /** The people connected, oldest first. Watchers are not among them. */
  private peers() {
    return this.ctx
      .getWebSockets()
      .map(peerOf)
      .filter((peer): peer is Peer => peer !== null && !peer.watch)
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  /** Sends what the channel server sent, from the peer id "server". Watchers get none of it. */
  private deliver(messages: Array<ServerMessage>) {
    const sockets = this.ctx.getWebSockets().filter((socket) => !peerOf(socket)?.watch);
    for (const { to, data } of messages) {
      const text = JSON.stringify({ t: "message", from: SERVER_PEER, data });
      if (text.length > MAX_SERVER_MESSAGE_CHARS) {
        this.reportServerError("A server message exceeds 256 KB and was dropped");
        continue;
      }
      if (to === null) {
        for (const socket of sockets) trySend(socket, text);
        continue;
      }
      const target = sockets.find((socket) => peerOf(socket)?.id === to);
      if (target) trySend(target, text);
    }
  }

  /**
   * Logs a channel server error and shows it to the pages, as an "error" event. Errors for
   * everyone go out at most once a second, so a server that throws on every tick stays readable.
   */
  private reportServerError(error: string, to?: string) {
    const text = JSON.stringify({ t: "error", error, server: true });
    if (to) {
      const target = this.ctx.getWebSockets().find((socket) => peerOf(socket)?.id === to);
      if (target) trySend(target, text);
      return;
    }
    const now = Date.now();
    if (now - this.lastServerError < SERVER_ERROR_EVERY_MS) return;
    this.lastServerError = now;
    const peer = this.peers()[0];
    console.error(
      JSON.stringify({
        level: "ERROR",
        message: "Channel server error",
        slug: peer?.slug,
        channel: peer?.channel,
        error,
      }),
    );
    for (const socket of this.ctx.getWebSockets()) {
      if (!peerOf(socket)?.watch) trySend(socket, text);
    }
  }

  /** Sends to every socket but `except`, and with `peersOnly`, not to watchers. */
  private broadcast(message: unknown, except?: WebSocket, peersOnly = false) {
    const text = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except || (peersOnly && peerOf(socket)?.watch)) continue;
      trySend(socket, text);
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

/** What a peer's live version runs for the channel, if anything. */
function serverCode(peer: Peer): ServerCode | null {
  if (!peer.server || !peer.version || !peer.channel) return null;
  return { slug: peer.slug, version: peer.version, path: peer.server, channel: peer.channel };
}

function serverPeer(peer: Peer) {
  const { id, email, name, shape, color, joinedAt, state } = peer;
  return { id, email, name, shape, color, joinedAt, state };
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
 * `?watch=1` watches the channel without joining it: the socket gets the peers, their presence,
 * joins, and leaves, but others never see it and it cannot send. Launchers use it to show who is
 * in a lobby.
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
  const server = yield* liveServer(slug, name);
  const headers = new Headers({
    upgrade: "websocket",
    "x-nap-email": identity.email,
    "x-nap-name": encodeURIComponent(person.name || identity.email),
    "x-nap-shape": person.shape,
    "x-nap-color": person.color,
    "x-nap-slug": slug,
    "x-nap-channel": name,
  });
  if (expiresAt) headers.set("x-nap-expires-at", expiresAt);
  if (new URL(request.url).searchParams.get("watch") === "1") headers.set("x-nap-watch", "1");
  if (server) {
    headers.set("x-nap-version", server.version);
    headers.set("x-nap-server", server.path);
  }
  return yield* Effect.promise(() =>
    channels.getByName(`${slug}/${name}`).fetch("https://channel/", { headers }),
  );
});

/** The server file the site's live version runs for channel `name`, if any. */
const liveServer = Effect.fnUntraced(function* (slug: string, name: string) {
  const db = yield* Database;
  const site = yield* db.first<{ currentVersion: string | null }>(
    `SELECT current_version AS currentVersion FROM sites WHERE slug = ?`,
    slug,
  );
  if (!site?.currentVersion) return null;
  const path = serverFor(yield* siteManifest(slug, site.currentVersion), name);
  return path ? { version: site.currentVersion, path } : null;
});
