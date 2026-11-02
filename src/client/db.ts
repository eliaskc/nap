import type {
  NapChange,
  NapCollection,
  NapDocument,
  NapIdentity,
  NapSubscribeOptions,
  NapWriteOptions,
} from "./api";
import { NapError } from "./errors";
import { backoff, napJson, napPath, napSocketUrl } from "./paths";

type Change = NapChange & { version?: number };
type ChangesPage = { changes: Array<Change>; since: number; hasMore: boolean };

/** The person viewing the page. */
export function me() {
  return napJson<NapIdentity>("me");
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(napPath("data/") + path, options);
  if (response.status === 204) return undefined as T;
  const result = (await response.json()) as { error?: string; document?: NapDocument | null };
  if (!response.ok) {
    throw new NapError(result.error || "Nap request failed", response.status, result.document);
  }
  return result as T;
}

function write(method: string, data: unknown, headers?: Record<string, string>): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(data),
  };
}

function conditions(options?: NapWriteOptions) {
  const headers: Record<string, string> = {};
  if (options && options.ifVersion != null) headers["if-match"] = '"' + options.ifVersion + '"';
  if (options && options.ifNew) headers["if-none-match"] = "*";
  return headers;
}

function byNewest(a: NapDocument, b: NapDocument) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

type Subscriber = { poll(): void; apply(changes: Array<Change>): boolean };

// Subscribers by collection name. Writes from this page reach them at once, other pages'
// writes arrive over the live socket, and polling the changes feed catches anything missed.
const subscribers = new Map<string, Set<Subscriber>>();

function publish(name: string, change: Change) {
  const set = subscribers.get(name);
  if (set) for (const subscriber of set) subscriber.apply([change]);
}

function eachSubscriber(callback: (subscriber: Subscriber) => void) {
  for (const set of subscribers.values()) for (const subscriber of set) callback(subscriber);
}

function hasSubscribers() {
  for (const set of subscribers.values()) if (set.size) return true;
  return false;
}

// One WebSocket per page, for every collection.
const live: {
  socket: WebSocket | null;
  open: boolean;
  retries: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  ping: ReturnType<typeof setInterval> | undefined;
} = { socket: null, open: false, retries: 0, timer: undefined, ping: undefined };

function connect() {
  clearTimeout(live.timer);
  if (live.socket || !hasSubscribers() || typeof WebSocket !== "function") return;
  const url = napSocketUrl("live");
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
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
    live.timer = setTimeout(connect, backoff(live.retries++, 1000, 30000));
  };
}

function disconnect() {
  clearTimeout(live.timer);
  if (live.socket && !hasSubscribers()) live.socket.close(1000, "Unsubscribed");
}

function subscribe(
  name: string,
  changes: (options: { since: number; limit: number }) => Promise<ChangesPage>,
  callback: (documents: Array<NapDocument>) => void,
  options: NapSubscribeOptions = {},
) {
  const interval = Math.max(Number(options.interval) || 3000, 1000);
  const documents = new Map<string, NapDocument>();
  // Versions of deleted documents, so a slow poll cannot bring one back.
  const deleted = new Map<string, number>();
  let since = 0;
  let loaded = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const subscriber: Subscriber = {
    poll: () => void poll(),
    apply(list) {
      let changed = false;
      for (const change of list) {
        const known = documents.get(change.id);
        const knownVersion = known ? known.version : deleted.get(change.id) || 0;
        // A delete from this page has no version. Every write adds one.
        const version = change.version == null ? knownVersion + 1 : change.version;
        if (version <= knownVersion) continue;
        if ("deleted" in change && change.deleted) {
          documents.delete(change.id);
          deleted.set(change.id, version);
        } else {
          documents.set(change.id, change as NapDocument);
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
        const page = await changes({ since, limit: 1000 });
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
      if (options.onError) options.onError(error as NapError);
      else console.error(error);
    } finally {
      running = false;
      // With a live socket, polling is only a safety net.
      const wait = live.open ? Math.max(interval, 60000) : interval;
      if (!stopped) timer = setTimeout(poll, document.hidden ? wait * 10 : wait);
    }
  }

  function onVisible() {
    if (!document.hidden) void poll();
  }

  let set = subscribers.get(name);
  if (!set) subscribers.set(name, (set = new Set()));
  set.add(subscriber);
  document.addEventListener("visibilitychange", onVisible);
  void poll();
  connect();

  return function unsubscribe() {
    stopped = true;
    clearTimeout(timer);
    set.delete(subscriber);
    document.removeEventListener("visibilitychange", onVisible);
    disconnect();
  };
}

export function collection(name: string): NapCollection {
  if (!/^[a-z][a-z0-9_-]{0,47}$/.test(name)) {
    throw new TypeError("Invalid Nap collection name");
  }
  const base = encodeURIComponent(name);
  const item = (id: string) => base + "/" + encodeURIComponent(id);

  async function saved(promise: Promise<{ document: NapDocument }>) {
    const document = (await promise).document;
    publish(name, document);
    return document;
  }

  function changes(options: { since?: number; limit?: number } = {}) {
    const query = new URLSearchParams({ since: String(options.since || 0) });
    if (options.limit != null) query.set("limit", String(options.limit));
    return request<ChangesPage>(base + "?" + query);
  }

  return Object.freeze({
    list(options: { limit?: number; cursor?: string } = {}) {
      const query = new URLSearchParams();
      if (options.limit != null) query.set("limit", String(options.limit));
      if (options.cursor) query.set("cursor", options.cursor);
      const suffix = query.size ? "?" + query : "";
      return request<{ documents: Array<NapDocument>; nextCursor: string | null }>(base + suffix);
    },
    async get(id: string) {
      return (await request<{ document: NapDocument }>(item(id))).document;
    },
    create(data: Record<string, unknown>) {
      return saved(request(base, write("POST", data)));
    },
    // Replaces a document that exists. { ifVersion } also fails if someone saved in between.
    update(id: string, data: Record<string, unknown>, options: NapWriteOptions = {}) {
      const headers = options.ifVersion != null ? conditions(options) : { "if-match": "*" };
      return saved(request(item(id), write("PUT", data, headers)));
    },
    // Creates or replaces the document with this id. { ifNew: true } only creates.
    put(id: string, data: Record<string, unknown>, options: NapWriteOptions = {}) {
      return saved(request(item(id), write("PUT", data, conditions(options))));
    },
    // Merges fields into a document (JSON Merge Patch: null removes a field).
    patch(id: string, data: Record<string, unknown>, options: NapWriteOptions = {}) {
      return saved(request(item(id), write("PATCH", data, conditions(options))));
    },
    async delete(id: string, options: NapWriteOptions = {}) {
      await request(item(id), { method: "DELETE", headers: conditions(options) });
      publish(name, { id, deleted: true });
    },
    changes,
    // Calls back with every document, newest first, now and after each change.
    subscribe(callback: (documents: Array<NapDocument>) => void, options?: NapSubscribeOptions) {
      return subscribe(name, changes, callback, options);
    },
  });
}
