# Voice on Nap (nap.voice)

`nap.voice` puts the people on a page in one audio call, like a voice channel. Everyone who joins the same name hears everyone else. Audio goes directly between the browsers over WebRTC; Nap only connects them and never hears it. A call works well up to about eight people.

Load `<script src="/_nap/client.js"></script>`, then:

- `const call = nap.voice()` for one call per nap, or `nap.voice("table-2")` for separate calls. A call is a channel with that name (`channels` topic), so do not use the name for anything else. The same name returns the same object until `call.close()`.
- `call.participants` is who is in the call, oldest first: `{ id, email, name, self, muted, speaking, connection, meta }`. It works before this page joins, so a page can show "3 in voice". `connection` is this page's link to that person ("connecting", "connected", "failed", ...); it is null for this page and while this page is not in the call.
- `await call.join()` asks for the microphone and joins. Call it from a click: browsers only allow the microphone and sound after one. It throws a `NapError` with status 403 when the person denies the microphone and 404 without one; show that in the page.
- `call.leave()`, `call.setMuted(true | false)`, `call.muted`, `call.status` ("idle", "joining", "joined"), and `call.joined`.
- Microphones: when `call.canSelectInput` is true, `call.inputs` lists `{ deviceId, label }` and `call.input` is the one in use. `await call.setInput(deviceId)` switches during a call without reconnecting (null: the system default); before joining it picks the one `join()` opens. Names appear once the person allowed the microphone, so show a picker only when there is more than one input. Remember the choice in `localStorage` if you like. An unplugged microphone falls back to the default.
- `call.setMeta(value)` shares a little state of this page with the others in the call (up to about 800 bytes of JSON), such as `{ captions: true }`; it arrives as `participant.meta`.
- `call.on("change", (call) => render(call))` runs on every join, leave, mute, speaking, or connection change. `call.on("error", (error) => ...)`. Both return a function that removes the listener.
- Two tabs of one person are two participants. Closing the tab leaves the call.
- Loading another page leaves the call. Build a site with client-side routing (`"spa": true`, `sites` topic) so moving between pages keeps it. With separate HTML pages, remember in `sessionStorage` that the person was in the call and call `call.join()` on load of the next page. Once the person has allowed the microphone, that works without a click; if the browser holds back sound until a click, it starts at the first click or key press.

Show who is in the call and who is speaking, a Join button, and Mute and Leave buttons once joined.

```html
<script src="/_nap/client.js"></script>
<button id="join">Join voice</button> <button id="mute" hidden>Mute</button>
<ul id="people"></ul>
<script>
  const call = nap.voice();
  join.onclick = () => (call.joined ? call.leave() : call.join().catch((e) => alert(e.message)));
  mute.onclick = () => call.setMuted(!call.muted);
  call.on("change", () => {
    join.textContent = call.joined ? "Leave" : "Join voice";
    mute.hidden = !call.joined;
    mute.textContent = call.muted ? "Unmute" : "Mute";
    people.replaceChildren(
      ...call.participants.map((p) => {
        const li = document.createElement("li");
        li.textContent = p.name + (p.muted ? " (muted)" : p.speaking ? " (speaking)" : "");
        return li;
      }),
    );
  });
</script>
```

In React, keep the call in a module-level `const call = nap.voice()` and read it with `useSyncExternalStore`, subscribing with `call.on("change", ...)`. The getter returns a new array each time, so keep a snapshot that you replace in the listener.
