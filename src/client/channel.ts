import type { NapChannel, NapChannelEvents, NapChannelStatus, NapPeer } from "./api";
import { NapError } from "./errors";
import { backoff, emitTo, napSocketUrl } from "./paths";

type Events = NapChannelEvents;
type Listeners = { [E in keyof Events]: Set<(value: Events[E]) => void> };
type RawPeer = Omit<NapPeer, "self">;

// Channels: messages and presence between the pages that have the channel open. Nothing is
// stored. One socket per channel name; channel(name) returns the same object until leave().
const channels = new Map<string, NapChannel>();

export function channel(name: string): NapChannel {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new TypeError("Invalid Nap channel name");
  }
  const existing = channels.get(name);
  if (existing) return existing;

  const listeners: Listeners = {
    presence: new Set(),
    join: new Set(),
    leave: new Set(),
    message: new Set(),
    status: new Set(),
    error: new Set(),
  };
  const peers = new Map<string, NapPeer>();
  let socket: WebSocket | null = null;
  let selfId: string | null = null;
  let status: NapChannelStatus = "connecting";
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let left = false;
  let presence: unknown;
  let hasPresence = false;
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;
  let presenceSentAt = 0;

  function emit<E extends keyof Events>(event: E, value: Events[E]) {
    emitTo(listeners[event] as Set<(value: Events[E]) => void>, value);
  }
  function list() {
    return [...peers.values()].sort(
      (a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
  function peer(raw: RawPeer): NapPeer {
    return { ...raw, self: raw.id === selfId };
  }
  function setStatus(next: NapChannelStatus) {
    if (status === next) return;
    status = next;
    emit("status", next);
  }
  function raw(message: unknown) {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
  function flushPresence() {
    presenceTimer = null;
    presenceSentAt = Date.now();
    raw({ t: "presence", state: presence });
  }

  function connect() {
    if (left) return;
    if (typeof WebSocket !== "function") return setStatus("closed");
    const url = napSocketUrl("channel/" + name);
    setStatus("connecting");
    try {
      socket = new WebSocket(url);
    } catch {
      return setStatus("closed");
    }
    const current = socket;
    current.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data === "pong") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.t === "welcome") {
        selfId = message.id;
        retries = 0;
        peers.clear();
        for (const p of message.peers as Array<RawPeer>) peers.set(p.id, peer(p));
        clearInterval(pingTimer);
        pingTimer = setInterval(() => current.readyState === 1 && current.send("ping"), 30000);
        if (hasPresence) {
          const self = peers.get(message.id);
          if (self) self.state = presence;
          flushPresence();
        }
        setStatus("open");
        emit("presence", list());
      } else if (message.t === "join") {
        const joined = peer(message.peer);
        peers.set(joined.id, joined);
        emit("join", joined);
        emit("presence", list());
      } else if (message.t === "leave") {
        const gone = peers.get(message.id);
        if (!gone) return;
        peers.delete(message.id);
        emit("leave", gone);
        emit("presence", list());
      } else if (message.t === "presence") {
        const changed = peers.get(message.id);
        if (!changed) return;
        changed.state = message.state;
        emit("presence", list());
      } else if (message.t === "message") {
        emit("message", { from: peers.get(message.from.id) || message.from, data: message.data });
      } else if (message.t === "error") {
        emit("error", new NapError(message.error, 400));
      }
    };
    current.onclose = (event) => {
      if (socket !== current) return;
      clearInterval(pingTimer);
      socket = null;
      selfId = null;
      const hadPeers = peers.size > 0;
      peers.clear();
      if (hadPeers) emit("presence", []);
      if (left) return setStatus("closed");
      // 4403: access changed; 4401: the artifact view expired. Reconnecting would not help.
      if (event.code === 4403 || event.code === 4401) {
        setStatus("closed");
        emit("error", new NapError(event.reason || "Disconnected", 403));
        return;
      }
      setStatus("connecting");
      retryTimer = setTimeout(connect, backoff(retries++, 500, 15000));
    };
  }

  const api: NapChannel = Object.freeze({
    name,
    /** This page's peer id, once connected. */
    get id() {
      return selfId;
    },
    /** "connecting", "open", or "closed". */
    get status() {
      return status;
    },
    /** Everyone connected, this page included (self: true), oldest first. */
    get peers() {
      return list();
    },
    /** The longest-connected peer. Every page agrees on it, so it can run shared state. */
    get host() {
      return list()[0] || null;
    },
    get isHost() {
      const first = list()[0];
      return Boolean(first && first.self);
    },
    on<E extends keyof Events>(event: E, listener: (value: Events[E]) => void) {
      const set = Object.hasOwn(listeners, event)
        ? (listeners[event] as Set<(value: Events[E]) => void>)
        : undefined;
      if (!set) throw new TypeError("Unknown channel event: " + String(event));
      set.add(listener);
      return () => void set.delete(listener);
    },
    /** To every other page, or to one peer id with { to }. False if not connected. */
    send(data: unknown, options: { to?: string } = {}) {
      return raw({ t: "send", data, to: options.to });
    },
    /** This page's state for everyone, up to 1 KB. Sent at most 20 times a second. */
    setPresence(state: unknown) {
      presence = state === undefined ? null : state;
      hasPresence = true;
      const self = selfId && peers.get(selfId);
      if (self) {
        self.state = presence;
        emit("presence", list());
      }
      if (presenceTimer) return;
      const wait = 50 - (Date.now() - presenceSentAt);
      if (wait <= 0) flushPresence();
      else presenceTimer = setTimeout(flushPresence, wait);
    },
    leave() {
      left = true;
      clearTimeout(retryTimer);
      if (presenceTimer) clearTimeout(presenceTimer);
      channels.delete(name);
      if (socket) socket.close(1000, "Left");
      else setStatus("closed");
    },
  });
  channels.set(name, api);
  connect();
  return api;
}
