# Channels on Nap (nap.channel)

Channels are for what happens live between the people on a page: characters, cursors, game moves, reactions. They are not stored and handle about 20 updates a second. Results that must last (scores, finished games) go to a collection (`data` topic).

Load `<script src="/_nap/client.js"></script>`, then:

- `const room = nap.channel("lobby")`. Names are up to 64 letters, numbers, `_`, `-`; each name is its own room. The same name returns the same object until `room.leave()`.
- Presence: `room.setPresence({ x, y })` sets this page's state (up to 1 KB) for everyone. Late joiners get everyone's current presence. Nap sends it at most 20 times a second, so call it as often as you like.
- `room.on("presence", (peers) => draw(peers))` runs on every join, leave, or change. A peer is `{ id, email, name, joinedAt, state, self }`. `room.peers` is the same list and `room.id` is this page's id. Two tabs are two peers.
- Messages: `room.send(data)` to every other page, `room.send(data, { to: peerId })` to one. `room.on("message", ({ from, data }) => ...)`. Up to 16 KB, not stored; pages that are not connected miss them. send returns false when not connected.
- Nap sets `from`, email, and name itself, so pages cannot pretend to be someone else.
- Also `room.on("join" | "leave", (peer) => ...)`, `room.on("status", (s) => ...)` ("connecting", "open", "closed"), and `room.on("error", ...)`. It reconnects by itself.
- Limits: 40 messages a second per page, presence included (more are dropped), and 200 people per channel.

Nap runs no game code. Either each page controls its own things (its character, cursor, hand) with setPresence and send, which covers most games, or one page is the host for shared things (a ball, a timer, the deck): `room.host` is the longest-connected peer and `room.isHost` says whether this page is it. Every page agrees on the host, and the next page takes over when it leaves, so keep the latest shared state on every page. Draw other people smoothly by moving toward their latest presence each frame.

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
