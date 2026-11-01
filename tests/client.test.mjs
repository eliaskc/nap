import test from "node:test";
import assert from "node:assert/strict";
import { bundleClientScript } from "../scripts/lib/client-bundle.ts";

// The client as the Worker serves it (/_nap/client.js), run against fake browser globals.
const source = await bundleClientScript("src/client/index.ts");

/** A WebSocket the test drives: it records what the page sends and plays server messages. */
class FakeSocket {
  static all = [];
  readyState = 0;
  sent = [];
  constructor(url) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  // Test side.
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  messages() {
    return this.sent.filter((data) => data !== "ping").map((data) => JSON.parse(data));
  }
}

function page({ href = "https://game.nap.test/", navigator = {} } = {}) {
  FakeSocket.all = [];
  const window = {};
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  new Function(
    "window",
    "document",
    "location",
    "WebSocket",
    "navigator",
    "addEventListener",
    "removeEventListener",
    source,
  )(
    window,
    document,
    new URL(href),
    FakeSocket,
    navigator,
    () => {},
    () => {},
  );
  return window.nap;
}

const peer = (id, joinedAt, state = null) => ({
  id,
  email: `${id}@example.com`,
  name: id,
  joinedAt,
  state,
});

test("channel: one object per name, presence, messages, host", () => {
  const nap = page();
  const room = nap.channel("lobby");
  assert.equal(nap.channel("lobby"), room);
  assert.throws(() => nap.channel("no spaces"), TypeError);
  assert.throws(() => room.on("nope", () => {}), TypeError);
  assert.throws(() => room.on("constructor", () => {}), TypeError);

  const [socket] = FakeSocket.all;
  assert.equal(socket.url, "wss://game.nap.test/_nap/channel/lobby");
  assert.equal(room.status, "connecting");
  assert.equal(room.send({ hi: 1 }), false, "not connected yet");

  const seen = [];
  room.on("presence", (peers) => seen.push(peers.map((p) => `${p.id}${p.self ? "*" : ""}`)));
  const statuses = [];
  room.on("status", (status) => statuses.push(status));
  room.setPresence({ x: 1 });

  socket.open();
  socket.receive({ t: "welcome", id: "b", peers: [peer("a", 1), peer("b", 2)] });
  assert.equal(room.id, "b");
  assert.equal(room.status, "open");
  assert.deepEqual(statuses, ["open"]);
  assert.equal(room.host.id, "a");
  assert.equal(room.isHost, false);
  assert.deepEqual(room.peers.find((p) => p.self).state, { x: 1 }, "presence set before welcome");
  assert.deepEqual(socket.messages(), [{ t: "presence", state: { x: 1 } }]);

  socket.receive({ t: "join", peer: peer("c", 3) });
  socket.receive({ t: "presence", id: "a", state: { x: 9 } });
  socket.receive({ t: "leave", id: "a" });
  assert.deepEqual(seen.at(-1), ["b*", "c"]);
  assert.equal(room.isHost, true, "the next page takes over");

  const messages = [];
  room.on("message", (message) => messages.push(message));
  socket.receive({ t: "message", from: { id: "c" }, data: { move: 1 } });
  assert.equal(messages[0].from.name, "c");
  assert.deepEqual(messages[0].data, { move: 1 });

  assert.equal(room.send({ to: "all" }), true);
  assert.equal(room.send("hi", { to: "c" }), true);
  assert.deepEqual(socket.messages().slice(1), [
    { t: "send", data: { to: "all" } },
    { t: "send", data: "hi", to: "c" },
  ]);

  room.leave();
  assert.equal(room.status, "closed");
  assert.notEqual(nap.channel("lobby"), room, "a new object after leave");
});

test("channel: reconnects after a drop, but not when access is gone", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const nap = page();
  const room = nap.channel("lobby");
  FakeSocket.all[0].open();
  FakeSocket.all[0].receive({ t: "welcome", id: "a", peers: [peer("a", 1)] });

  FakeSocket.all[0].drop();
  assert.equal(room.status, "connecting");
  assert.equal(room.peers.length, 0);
  t.mock.timers.tick(1000);
  assert.equal(FakeSocket.all.length, 2, "reconnected");

  const errors = [];
  room.on("error", (error) => errors.push(error));
  FakeSocket.all[1].open();
  FakeSocket.all[1].drop(4403, "Access changed");
  t.mock.timers.tick(60_000);
  assert.equal(FakeSocket.all.length, 2, "no reconnect after 4403");
  assert.equal(room.status, "closed");
  assert.equal(errors[0].name, "NapError");
  assert.equal(errors[0].status, 403);
});

test("channel: presence goes out at most 20 times a second", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10_000 });
  const nap = page();
  const room = nap.channel("lobby");
  const [socket] = FakeSocket.all;
  socket.open();
  socket.receive({ t: "welcome", id: "a", peers: [peer("a", 1)] });
  for (let x = 0; x < 10; x++) room.setPresence({ x });
  assert.deepEqual(socket.messages(), [{ t: "presence", state: { x: 0 } }]);
  t.mock.timers.tick(50);
  assert.deepEqual(socket.messages().at(-1), { t: "presence", state: { x: 9 } });
  assert.equal(socket.messages().length, 2);
});

test("paths: artifacts and the local dev server", () => {
  const artifact = page({ href: "https://nap.test/_nap/frame/tok_1/index.html" });
  artifact.channel("lobby");
  assert.equal(FakeSocket.all[0].url, "wss://nap.test/_nap/frame/tok_1/_nap/channel/lobby");

  const local = page({ href: "http://localhost:3000/s/game/" });
  local.channel("lobby");
  assert.equal(FakeSocket.all[0].url, "ws://localhost:3000/s/game/_nap/channel/lobby");

  const outside = page({ href: "http://localhost:3000/" });
  assert.throws(() => outside.channel("lobby"), { name: "NapError", status: 400 });
});

test("voice: participants come from the channel before joining", async () => {
  const nap = page();
  const call = nap.voice();
  assert.equal(nap.voice(), call);
  assert.equal(call.status, "idle");
  assert.equal(call.canSelectInput, false);
  const [socket] = FakeSocket.all;
  assert.equal(socket.url, "wss://game.nap.test/_nap/channel/voice");
  socket.open();
  socket.receive({
    t: "welcome",
    id: "me",
    peers: [
      peer("a", 1, { inCall: true, muted: true, meta: { captions: true } }),
      peer("b", 2, null),
      peer("me", 3, null),
    ],
  });
  assert.deepEqual(call.participants, [
    {
      id: "a",
      email: "a@example.com",
      name: "a",
      self: false,
      muted: true,
      meta: { captions: true },
      speaking: false,
      connection: null,
    },
  ]);
  const changes = [];
  call.on("change", (value) => changes.push(value));
  socket.receive({ t: "presence", id: "b", state: { inCall: true } });
  assert.equal(changes.length, 1);
  assert.equal(changes[0], call);
  assert.deepEqual(
    call.participants.map((p) => p.id),
    ["a", "b"],
  );

  // No WebRTC in this "browser".
  await assert.rejects(call.join(), { name: "NapError", status: 400 });
  call.close();
  assert.equal(socket.readyState, 3, "close leaves the channel");
  await assert.rejects(call.join(), { name: "NapError", status: 400 });
});
