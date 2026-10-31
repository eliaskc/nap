const CLIENT_SOURCE = String.raw`(() => {
  class NapError extends Error {
    constructor(message, status, document) {
      super(message);
      this.name = "NapError";
      this.status = status;
      // A 409 carries the current document (null if it is gone), so the app can merge or ask.
      if (document !== undefined) this.document = document;
    }
  }

  function napPath(suffix) {
    // An artifact: its files are below /_nap/frame/<token>/, and so is its data.
    const frame = location.pathname.match(/^\/_nap\/frame\/([A-Za-z0-9_-]+)\//);
    if (frame) return "/_nap/frame/" + frame[1] + "/_nap/" + suffix;
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (!local) return "/_nap/" + suffix;
    const match = location.pathname.match(/^\/s\/([^/]+)(?:\/|$)/);
    if (!match) throw new NapError("Nap site data is unavailable outside a site", 400);
    return "/s/" + encodeURIComponent(match[1]) + "/_nap/" + suffix;
  }

  function dataBasePath() {
    return napPath("data/");
  }

  async function me() {
    const response = await fetch(napPath("me"));
    const result = await response.json();
    if (!response.ok) throw new NapError(result.error || "Nap request failed", response.status);
    return result;
  }

  async function request(path, options) {
    const response = await fetch(dataBasePath() + path, options);
    if (response.status === 204) return undefined;
    const result = await response.json();
    if (!response.ok) {
      throw new NapError(result.error || "Nap request failed", response.status, result.document);
    }
    return result;
  }

  function write(method, data, headers) {
    return {
      method,
      headers: Object.assign({ "content-type": "application/json" }, headers),
      body: JSON.stringify(data),
    };
  }

  function conditions(options) {
    const headers = {};
    if (options && options.ifVersion != null) headers["if-match"] = '"' + options.ifVersion + '"';
    if (options && options.ifNew) headers["if-none-match"] = "*";
    return headers;
  }

  function byNewest(a, b) {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  }

  // Subscribers by collection name. Writes from this page reach them at once, other pages'
  // writes arrive over the live socket, and polling the changes feed catches anything missed.
  const subscribers = new Map();

  function publish(name, change) {
    const set = subscribers.get(name);
    if (set) for (const subscriber of set) subscriber.apply([change]);
  }

  function eachSubscriber(callback) {
    for (const set of subscribers.values()) for (const subscriber of set) callback(subscriber);
  }

  function hasSubscribers() {
    for (const set of subscribers.values()) if (set.size) return true;
    return false;
  }

  // One WebSocket per page, for every collection.
  const live = { socket: null, open: false, retries: 0, timer: undefined, ping: undefined };

  function connect() {
    clearTimeout(live.timer);
    if (live.socket || !hasSubscribers() || typeof WebSocket !== "function") return;
    const url = new URL(napPath("live"), location.href);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    let socket;
    try {
      socket = new WebSocket(url.href);
    } catch {
      return;
    }
    live.socket = socket;
    socket.onopen = () => {
      live.open = true;
      live.retries = 0;
      live.ping = setInterval(() => socket.readyState === 1 && socket.send("ping"), 30000);
      // Catch up on anything written while there was no socket.
      eachSubscriber((subscriber) => subscriber.poll());
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data === "pong") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message && message.type === "change") publish(message.collection, message.change);
    };
    socket.onclose = (event) => {
      clearInterval(live.ping);
      const wasOpen = live.open;
      live.socket = null;
      live.open = false;
      if (wasOpen) eachSubscriber((subscriber) => subscriber.poll());
      // 4403: access changed; 4401: the artifact view expired. Polling reports the error, and
      // reconnecting would not help.
      if (event.code === 4403 || event.code === 4401 || !hasSubscribers()) return;
      const delay = Math.min(30000, 1000 * 2 ** live.retries++) * (0.5 + Math.random() / 2);
      live.timer = setTimeout(connect, delay);
    };
  }

  function disconnect() {
    clearTimeout(live.timer);
    if (live.socket && !hasSubscribers()) live.socket.close(1000, "Unsubscribed");
  }

  function subscribe(name, changes, callback, options = {}) {
    const interval = Math.max(Number(options.interval) || 3000, 1000);
    const documents = new Map();
    // Versions of deleted documents, so a slow poll cannot bring one back.
    const deleted = new Map();
    let since = 0;
    let loaded = false;
    let stopped = false;
    let timer;
    let running = false;

    const subscriber = {
      poll: () => poll(),
      apply(list) {
        let changed = false;
        for (const change of list) {
          const known = documents.get(change.id);
          const knownVersion = known ? known.version : deleted.get(change.id) || 0;
          // A delete from this page has no version. Every write adds one.
          const version = change.version == null ? knownVersion + 1 : change.version;
          if (version <= knownVersion) continue;
          if (change.deleted) {
            documents.delete(change.id);
            deleted.set(change.id, version);
          } else {
            documents.set(change.id, change);
            deleted.delete(change.id);
          }
          changed = true;
        }
        if (changed && loaded && !stopped) emit();
        return changed;
      },
    };

    function emit() {
      try {
        callback([...documents.values()].sort(byNewest));
      } catch (error) {
        console.error(error);
      }
    }

    async function poll() {
      if (stopped || running) return;
      running = true;
      clearTimeout(timer);
      try {
        let more = true;
        while (more && !stopped) {
          const page = await changes({ since, limit: 100 });
          // Emits once loaded. The first load emits once, below.
          subscriber.apply(page.changes);
          since = page.since;
          more = page.hasMore;
        }
        if (!stopped && !loaded) {
          loaded = true;
          emit();
        }
      } catch (error) {
        if (options.onError) options.onError(error);
        else console.error(error);
      } finally {
        running = false;
        // With a live socket, polling is only a safety net.
        const wait = live.open ? Math.max(interval, 60000) : interval;
        if (!stopped) timer = setTimeout(poll, document.hidden ? wait * 10 : wait);
      }
    }

    function onVisible() {
      if (!document.hidden) poll();
    }

    let set = subscribers.get(name);
    if (!set) subscribers.set(name, (set = new Set()));
    set.add(subscriber);
    document.addEventListener("visibilitychange", onVisible);
    poll();
    connect();

    return function unsubscribe() {
      stopped = true;
      clearTimeout(timer);
      set.delete(subscriber);
      document.removeEventListener("visibilitychange", onVisible);
      disconnect();
    };
  }

  function collection(name) {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name)) {
      throw new TypeError("Invalid Nap collection name");
    }
    const base = encodeURIComponent(name);
    const item = (id) => base + "/" + encodeURIComponent(id);

    async function saved(promise) {
      const document = (await promise).document;
      publish(name, document);
      return document;
    }

    async function changes(options = {}) {
      const query = new URLSearchParams({ since: String(options.since || 0) });
      if (options.limit != null) query.set("limit", String(options.limit));
      return request(base + "?" + query);
    }

    return Object.freeze({
      async list(options = {}) {
        const query = new URLSearchParams();
        if (options.limit != null) query.set("limit", String(options.limit));
        if (options.cursor) query.set("cursor", options.cursor);
        const suffix = query.size ? "?" + query : "";
        return request(base + suffix);
      },
      async get(id) {
        return (await request(item(id))).document;
      },
      create(data) {
        return saved(request(base, write("POST", data)));
      },
      // Replaces a document that exists. { ifVersion } also fails if someone saved in between.
      update(id, data, options = {}) {
        const headers = options.ifVersion != null ? conditions(options) : { "if-match": "*" };
        return saved(request(item(id), write("PUT", data, headers)));
      },
      // Creates or replaces the document with this id. { ifNew: true } only creates.
      put(id, data, options = {}) {
        return saved(request(item(id), write("PUT", data, conditions(options))));
      },
      // Merges fields into a document (JSON Merge Patch: null removes a field).
      patch(id, data, options = {}) {
        return saved(request(item(id), write("PATCH", data, conditions(options))));
      },
      async delete(id, options = {}) {
        await request(item(id), { method: "DELETE", headers: conditions(options) });
        publish(name, { id, deleted: true });
      },
      changes,
      // Calls back with every document, newest first, now and after each change.
      subscribe(callback, options) {
        return subscribe(name, changes, callback, options);
      },
    });
  }

  // Channels: messages and presence between the pages that have the channel open. Nothing is
  // stored. One socket per channel name; channel(name) returns the same object until leave().
  const channels = new Map();
  const CHANNEL_EVENTS = ["presence", "join", "leave", "message", "status", "error"];

  function channel(name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
      throw new TypeError("Invalid Nap channel name");
    }
    const existing = channels.get(name);
    if (existing) return existing;

    const listeners = new Map(CHANNEL_EVENTS.map((event) => [event, new Set()]));
    const peers = new Map();
    let socket = null;
    let selfId = null;
    let status = "connecting";
    let retries = 0;
    let retryTimer;
    let pingTimer;
    let left = false;
    let presence;
    let hasPresence = false;
    let presenceTimer = null;
    let presenceSentAt = 0;

    function emit(event, value) {
      for (const listener of listeners.get(event)) {
        try {
          listener(value);
        } catch (error) {
          console.error(error);
        }
      }
    }
    function list() {
      return [...peers.values()].sort(
        (a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    }
    function peer(raw) {
      return Object.assign({}, raw, { self: raw.id === selfId });
    }
    function setStatus(next) {
      if (status === next) return;
      status = next;
      emit("status", next);
    }
    function raw(message) {
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
      const url = new URL(napPath("channel/" + name), location.href);
      url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
      setStatus("connecting");
      try {
        socket = new WebSocket(url.href);
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
          for (const p of message.peers) peers.set(p.id, peer(p));
          clearInterval(pingTimer);
          pingTimer = setInterval(() => current.readyState === 1 && current.send("ping"), 30000);
          if (hasPresence) {
            peers.get(selfId).state = presence;
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
        const delay = Math.min(15000, 500 * 2 ** retries++) * (0.5 + Math.random() / 2);
        retryTimer = setTimeout(connect, delay);
      };
    }

    const api = Object.freeze({
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
      on(event, listener) {
        const set = listeners.get(event);
        if (!set) throw new TypeError("Unknown channel event: " + event);
        set.add(listener);
        return () => set.delete(listener);
      },
      /** To every other page, or to one peer id with { to }. False if not connected. */
      send(data, options = {}) {
        return raw({ t: "send", data, to: options.to });
      },
      /** This page's state for everyone, up to 1 KB. Sent at most 20 times a second. */
      setPresence(state) {
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
        clearTimeout(presenceTimer);
        channels.delete(name);
        if (socket) socket.close(1000, "Left");
        else setStatus("closed");
      },
    });
    channels.set(name, api);
    connect();
    return api;
  }

  // Reads a public URL through Nap, for APIs that do not allow other origins. The site lists
  // the hosts in nap.json: { "fetch": ["api.example.com", "*.example.org"] }.
  async function proxyFetch(url, options = {}) {
    const target = new URL(url, location.href).toString();
    const response = await fetch(napPath("fetch?url=" + encodeURIComponent(target)), {
      method: options.method || "GET",
      headers: options.headers,
      signal: options.signal,
    });
    if (!response.headers.get("x-nap-fetch")) {
      const result = await response.json().catch(() => ({}));
      throw new NapError(result.error || "Nap fetch failed", response.status);
    }
    return response;
  }

  const nap = Object.freeze({
    channel,
    fetch: proxyFetch,
    db: Object.freeze({ collection }),
    me,
    NapError,
  });

  Object.defineProperty(window, "nap", { value: nap, enumerable: true });
})();`;

export function serveSiteDataClient() {
  return new Response(CLIENT_SOURCE, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
