# Channels on Nap (nap.channel)

Channels are for what happens live between the people on a page: characters, cursors, game moves, reactions. They are not stored and handle about 20 updates a second. Results that must last (scores, finished games) go to a collection (`data` topic).

Load `<script src="/_nap/client.js"></script>`, then:

- `const room = nap.channel("lobby")`. Names are up to 64 letters, numbers, `_`, `-`; each name is its own room. The same name returns the same object until `room.leave()`.
- Presence: `room.setPresence({ x, y })` sets this page's state (up to 1 KB) for everyone. Late joiners get everyone's current presence. Nap sends it at most 20 times a second, so call it as often as you like.
- `room.on("presence", (peers) => draw(peers))` runs on every join, leave, or change. A peer is `{ id, email, name, shape, color, joinedAt, state, self }`; draw people with their look (see People in the `sites` topic). `room.peers` is the same list and `room.id` is this page's id. Two tabs are two peers.
- Messages: `room.send(data)` to every other page, `room.send(data, { to: peerId })` to one. `room.on("message", ({ from, data }) => ...)`. Up to 16 KB, not stored; pages that are not connected miss them. send returns false when not connected.
- Nap sets `from`, email, and name itself, so pages cannot pretend to be someone else.
- Also `room.on("join" | "leave", (peer) => ...)`, `room.on("status", (s) => ...)` ("connecting", "open", "closed"), and `room.on("error", ...)`. It reconnects by itself.
- Limits: 40 messages a second per page, presence included (more are dropped), and 200 people per channel.

Shared things (a ball, a timer, the deck, a game's world) need one place that decides. Either each page controls its own things (its character, cursor, hand) with setPresence and send, which covers most games, or one page is the host for shared things: `room.host` is the longest-connected peer and `room.isHost` says whether this page is it. Every page agrees on the host, and the next page takes over when it leaves, so keep the latest shared state on every page. Draw other people smoothly by moving toward their latest presence each frame.

<!-- if channelServers -->

## Channel servers

When a page as host is not enough (a real-time game whose simulation must not stop when the host's tab goes to the background, a referee nobody can cheat, state that outlives the host), the site can run its own JavaScript on Nap as the channel's server. Use it for games with a shared simulation; plain presence and messages do not need it.

- Name it in `nap.json` at the root of the upload: `{ "servers": { "game-*": "server.js" } }`. Keys are channel names, with `*` for any characters; the first match wins. Values are JavaScript files in the upload. Channels without a match have no server.
- The file is one ES module with no imports (bundle it, for example `esbuild server.ts --bundle --format=esm --outfile=dist/server.js`), up to 5 MB. It runs in a sandbox with no network (`fetch` fails) and no Nap APIs. It is served like any other file, so it is not secret.
- It exports a class. Every method is optional and may be async:

```js
export default class Game {
  constructor(channel) {
    this.channel = channel; // { name, peers, send, setTickRate, tickRate, storage }
    this.world = channel.storage.get("world") ?? newWorld();
    channel.setTickRate(20); // tick() 20 times a second, up to 30; 0 stops
  }
  join(peer) {
    this.channel.send({ type: "world", world: this.world }, { to: peer.id });
  }
  leave(peer) {}
  presence(peer) {} // peer.state changed
  message(peer, data) {
    applyInput(this.world, peer.id, data);
  }
  tick(dt) {
    step(this.world, dt);
    this.channel.send({ type: "state", world: this.world });
  }
}
```

- A peer is `{ id, email, name, shape, color, joinedAt, state }`; Nap sets who it is. `channel.peers` is everyone connected, oldest first. `channel.send(data)` goes to every page and `channel.send(data, { to: peer.id })` to one; up to 256 KB a message, sent when the method returns. Calls come one at a time, in order. Do work in methods and `tick`, not in `setTimeout`.
- The server starts when the first person joins and stops when the last one leaves, and it runs the version that was live when it started; after you publish, the next session gets the new code. Memory is lost when it stops. `channel.storage` (`get`, `put`, `delete`, `list({ prefix })`, values up to about 2 MB) is the server's own and lasts across sessions and versions; use collections for results people look at (`data` topic).
- On the pages, `room.server` is true once connected, `room.host` is null, and `room.isHost` is false. Send to the server with `room.send(data, { to: "server" })`; its messages arrive with `from.id === "server"`. Pages can still message each other.
- When the server throws, or fails to start, pages get an `error` event and the browser console shows it. A server that throws keeps running.
- Test the class locally by calling its methods with a fake `channel` (an object with `peers`, `send` that records, `setTickRate`, and a `Map`-backed `storage`), then publish and try it in two windows.
<!-- /if -->

```html
<script src="/_nap/client.js"></script>
<script>
  const room = nap.channel("lobby");
  const me = { x: 100, y: 100 };
  addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") me.x += 10;
    room.setPresence(me);
  });
  room.on("presence", (peers) => draw(peers));
  room.on("message", ({ from, data }) => data.type === "wave" && showWave(from.name));
</script>
```
