// Checks channel servers against Nap on a new local Alchemy stage: a site's server.js runs in its
// channel object (a Dynamic Worker facet), hears joins, leaves, and messages, ticks, keeps its
// storage, has no network, and runs the version that was live when the channel filled.
// Never touches production.
import assert from "node:assert/strict";
import { startLocalNap } from "../lib/local-nap.mjs";

const PORT = 8797;
const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const SLUG = "arena";

const SERVER_V1 = `
export default class Arena {
  constructor(channel) {
    this.channel = channel;
    this.ticks = 0;
    this.count = channel.storage.get("count") ?? 0;
    channel.setTickRate(20);
  }
  join(peer) {
    this.channel.send(
      { type: "hello", version: 1, name: peer.email, peers: this.channel.peers.length, channel: this.channel.name },
      { to: peer.id },
    );
  }
  leave(peer) {
    this.channel.send({ type: "left", email: peer.email });
  }
  presence(peer) {
    this.channel.send({ type: "saw", state: peer.state }, { to: peer.id });
  }
  async message(peer, data) {
    if (data.type === "add") {
      this.count += data.n;
      this.channel.storage.put("count", this.count);
      this.channel.send({ type: "count", count: this.count, by: peer.email });
    }
    if (data.type === "throw") throw new Error("boom");
    if (data.type === "fetch") {
      try {
        await fetch("https://example.com/");
        this.channel.send({ type: "fetched" }, { to: peer.id });
      } catch (error) {
        this.channel.send({ type: "fetch-blocked" }, { to: peer.id });
      }
    }
    if (data.type === "ticks") this.channel.send({ type: "ticks", ticks: this.ticks }, { to: peer.id });
  }
  tick(dt) {
    this.ticks++;
  }
}
`;

const SERVER_V2 = `
export default class {
  constructor(channel) { this.channel = channel; }
  join(peer) { this.channel.send({ type: "hello", version: 2, count: this.channel.storage.get("count") }, { to: peer.id }); }
}
`;

/** A WebSocket to a channel, with a queue of what arrives. */
async function connect(channel, email, query = "") {
  const socket = new WebSocket(`ws://localhost:${PORT}/s/${SLUG}/_nap/channel/${channel}${query}`, {
    headers: { "x-nap-dev-email": email, "cf-access-authenticated-user-email": email },
  });
  const inbox = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    if (event.data === "pong") return;
    const message = JSON.parse(event.data);
    inbox.push(message);
    for (const waiter of waiters.slice()) waiter();
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`${email} could not connect`)), {
      once: true,
    });
  });
  return {
    socket,
    inbox,
    send: (message) => socket.send(JSON.stringify(message)),
    /** The first message (taken from the inbox) that matches, within a few seconds. */
    next(match, label = "message") {
      return new Promise((resolve, reject) => {
        const check = () => {
          const index = inbox.findIndex(match);
          if (index < 0) return false;
          const [message] = inbox.splice(index, 1);
          waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          resolve(message);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error(`${email}: no ${label}. Inbox: ${JSON.stringify(inbox)}`));
        }, 8000);
        waiters.push(check);
        check();
      });
    },
    close() {
      socket.close();
    },
  };
}

const fromServer = (type) => (m) =>
  m.t === "message" && m.from.id === "server" && m.data.type === type;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nap;
try {
  nap = await startLocalNap({ port: PORT, label: "channel-servers" });
  await nap.sql("INSERT INTO profiles (email) VALUES (?), (?)", OWNER, OTHER);
  await nap.sql(
    `INSERT INTO sites (slug, kind, title, visibility, created_by_email, updated_by_email,
       current_version, sort_order)
     VALUES (?, 'site', 'Arena', 'everyone', ?, ?, 'v1', 0)`,
    SLUG,
    OWNER,
    OWNER,
  );
  const files = {
    "v1/nap.json": JSON.stringify({ servers: { "game-*": "server/arena.js", broken: "bad.js" } }),
    "v1/server/arena.js": SERVER_V1,
    "v1/bad.js": "export default class { constructor() { throw new Error('nope') } }",
    "v2/nap.json": JSON.stringify({ servers: { "game-*": "server.js" } }),
    "v2/server.js": SERVER_V2,
  };
  for (const [path, body] of Object.entries(files)) {
    await nap.put(`sites/${SLUG}/versions/${path}`, body);
  }

  // The first person starts the server, which greets them.
  const a = await connect("game-1", OWNER);
  const welcome = await a.next((m) => m.t === "welcome", "welcome");
  assert.equal(welcome.server, true, "the welcome says the channel has a server");
  const hello = await a.next(fromServer("hello"), "hello");
  assert.deepEqual(hello.data, {
    type: "hello",
    version: 1,
    name: OWNER,
    peers: 1,
    channel: "game-1",
  });
  assert.equal(hello.from.name, "Server");

  // A second person joins the running server.
  const b = await connect("game-1", OTHER);
  assert.equal((await b.next(fromServer("hello"))).data.peers, 2);

  // Messages to the server, and its broadcasts to everyone.
  a.send({ t: "send", to: "server", data: { type: "add", n: 2 } });
  assert.deepEqual((await b.next(fromServer("count"))).data, {
    type: "count",
    count: 2,
    by: OWNER,
  });
  b.send({ t: "send", to: "server", data: { type: "add", n: 3 } });
  const counted = await a.next((m) => fromServer("count")(m) && m.data.count === 5);
  assert.equal(counted.data.by, OTHER, "the server knows who sent it");
  await b.next(fromServer("count"));
  assert.equal(
    b.inbox.some((m) => m.t === "message" && m.from.id !== "server"),
    false,
    "messages to the server do not reach other pages",
  );

  // Presence reaches the server.
  a.send({ t: "presence", state: { x: 1 } });
  assert.deepEqual((await a.next(fromServer("saw"))).data.state, { x: 1 });

  // It ticks at its own rate.
  await wait(600);
  a.send({ t: "send", to: "server", data: { type: "ticks" } });
  const { ticks } = (await a.next(fromServer("ticks"))).data;
  assert.ok(ticks >= 5, `ticks at 20 Hz (got ${ticks} after 600 ms)`);

  // Errors reach the pages; the server keeps running.
  a.send({ t: "send", to: "server", data: { type: "throw" } });
  const error = await a.next((m) => m.t === "error" && m.server, "server error");
  assert.match(error.error, /boom/);
  // No network.
  a.send({ t: "send", to: "server", data: { type: "fetch" } });
  await a.next(fromServer("fetch-blocked"), "blocked fetch");

  // Watchers see who is here but are not players: they neither start the server nor hear it.
  const watcher = await connect("game-3", OTHER, "?watch=1");
  assert.equal((await watcher.next((m) => m.t === "welcome")).server, true);
  await wait(500);
  const p1 = await connect("game-3", OWNER);
  assert.equal((await p1.next(fromServer("hello"))).data.peers, 1, "the watcher is no peer");
  const p2 = await connect("game-3", OTHER);
  await p2.next(fromServer("hello"));
  p2.close();
  await p1.next(fromServer("left"));
  await wait(300);
  assert.equal(watcher.inbox.filter((m) => m.t === "message").length, 0, "no server traffic");
  watcher.close();
  p1.close();

  // A new version goes live: the running server keeps its version while people are connected.
  await nap.sql("UPDATE sites SET current_version = 'v2' WHERE slug = ?", SLUG);
  b.close();
  assert.equal((await a.next(fromServer("left"))).data.email, OTHER);
  const c = await connect("game-1", OTHER);
  assert.equal((await c.next(fromServer("hello"))).data.version, 1, "joins the running version");

  // When everyone has left, the next person starts the new version, with the same storage.
  a.close();
  c.close();
  await wait(500);
  const d = await connect("game-1", OWNER);
  const fresh = await d.next(fromServer("hello"));
  assert.deepEqual(
    fresh.data,
    { type: "hello", version: 2, count: 5 },
    "storage outlives versions",
  );
  d.close();

  // People who join while the server starts are greeted once.
  const [g, h] = await Promise.all([connect("game-2", OWNER), connect("game-2", OTHER)]);
  await g.next(fromServer("hello"));
  await h.next(fromServer("hello"));
  await wait(500);
  assert.equal([...g.inbox, ...h.inbox].filter(fromServer("hello")).length, 0, "one hello each");
  g.close();
  h.close();

  // Channels the manifest does not name have no server.
  const plain = await connect("lobby", OWNER);
  assert.equal((await plain.next((m) => m.t === "welcome")).server, false);
  plain.send({ t: "send", to: "server", data: {} });
  assert.match((await plain.next((m) => m.t === "error")).error, /no server/);
  plain.close();

  // A server that fails to start says so, to everyone who joins.
  await nap.sql("UPDATE sites SET current_version = 'v1' WHERE slug = ?", SLUG);
  const e = await connect("broken", OWNER);
  assert.match((await e.next((m) => m.t === "error" && m.server)).error, /failed to start: .*nope/);
  const f = await connect("broken", OTHER);
  assert.match((await f.next((m) => m.t === "error" && m.server)).error, /failed to start/);
  e.close();
  f.close();

  console.log("Channel server checks passed.");
} finally {
  await nap?.stop();
}
