# {{title}} for reMarkable

The reMarkable platform of this repo: the launcher for the reMarkable 2, with the apps built into
it. It runs under [AppLoad](https://github.com/asivery/rm-appload) (on xovi) inside the tablet's
own interface. It signs the tablet in to https://{{rootDomain}}, lists the apps in `apps/`, opens
them, and updates itself from Nap. Paths here are inside `remarkable/`; `../nap.json` names the
app on Nap.

## Layout

- `launcher/`: the AppLoad app. `ui/Main.qml` is the launcher (sign-in, the list of apps, updates).
  `ui/nap/` is the kit apps build on: the Nap client, the pen, buttons and avatars.
- `apps/<slug>/`: one folder per app, with `app.json` (`title`, `summary`, optional `site`) and
  `Main.qml`. `apps/hello` is the template app: copy it to start a new one. An app that is also
  on another platform uses the same slug there (`../ios/Apps/<slug>/`).
- `backend/`: the native side (Go, cross-compiled for the tablet's 32-bit ARM). QML talks to it
  through AppLoad's messages (`ui/nap/Backend.qml`). It does what QML on the tablet cannot:
  - signing in (Nap's device flow) and keeping the token,
  - HTTP to Nap with the token, and WebSockets with an `Authorization` header,
  - handwriting recognition, the same model and maths as the web pen (`hwr.go`),
  - small files (`kvGet`/`kvSet`) and updates (`update.go`).
- `scripts/`: build, preview, install, publish, and device tools (below).
- `tools/rminput/`: the input injector behind `scripts/rminput`.

## Writing an app

An app's `Main.qml` is a root item with `property var host`, `property real u` and `signal close`.
`u` is one tablet pixel (the screen is 1404 × 1872): size everything in multiples of it, so the Mac
preview matches the tablet. `host` is the launcher:

- `host.nap(site)`: the Nap client for a site, the same API as `window.nap` on the web:
  `db.collection(name)` (`list`, `get`, `create`, `put`, `patch`, `update`, `delete`, `subscribe`),
  `channel(name)` (`on`, `send`, `setPresence`, `leave`), `people()`, `me()`, `getDoc`, `mutate`
  and `ensureDoc`. Set `site` in `app.json` to the site whose data the app shares; the web
  version and the tablet then see the same data and channels.
- `host.me()`: the person signed in (`email`, `name`, `shape`, `color`).
- `host.kvGet(key)` / `host.kvSet(key, value)`: small files on the tablet, as promises.
- `host.setTimeout(fn, ms)` / `host.clearTimeout(id)`, `host.log(text)`, `host.close()`.
- Optional `function leave()`: called when the launcher closes the app.

QML here is Qt 6.10's JavaScript: Promises, classes, `?.` and `??`, but no `async`/`await`.
`ui/nap/polyfills.js` adds `at`, `findLast`, `toSorted` and `Object.hasOwn`. There is no
`fetch`; use the Nap client, or `host.backend.call("http", …)`.

### The pen

`ui/nap/pen/PenArea.qml` is the web pen (dle's `usePen`) for QML: put it over a grid of letter
cells and it reads handwriting into them. Write a letter per cell, or a whole word across cells;
a pause of 450 ms commits it. Scribble across cells to clear them. A tap with the pen moves the
cursor; `fixChoices` and `pick(letter)` give the "did you mean" chips. Give it `cells()` (the
boxes, in its coordinates), `value`, `writable` and `write`, and a Nap client as `log` to keep the
pen log in the site's `pen-log` collection, as the web does.

The recognizer's model (`launcher/pen/letters.bin`) and its geometry (`ui/nap/pen/pencore.js`)
come from dle; `scripts/sync-pen <dle checkout>` refreshes both.

### Designing for e-ink

- Black on white, greys at most. No animations, live cursors, or anything that moves on its own:
  every change redraws the screen, and the panel is slow.
- Large targets (at least 100 × 100 px) for fingers. The pen arrives as a real mouse
  (`Qt.MouseEventNotSynthesized`); fingers as synthesized ones. The eraser end is `Qt.MiddleButton`.
- For ink, use `DisplayMethodArea { displayMethod: DisplayMethodArea.Fast }` from
  `net.asivery.ApploadUtils`, as `PenArea` does.
- There is no keyboard worth using and no microphone. Typing should be handwriting.

## Build, preview, and test

Needs Go (`mise install`) and uv (for Qt's resource compiler and the preview, from PySide6).

- `scripts/build`: `build/app/` (the AppLoad folder) and `build/remarkable.zip`.
- `scripts/preview [--app <slug>] [--shot out.png] [--steps steps.json]`: the launcher on this Mac
  in a window, with the real backend, signed in to the Nap in `NAP_URL` (default: https://{{rootDomain}}).
  `--steps` drives it from a JSON list: `{"wait": ms}`, `{"shot": "out.png"}`,
  `{"click": [x, y]}`, `{"pen": [[x, y], …]}` (one stroke), `{"eval": "js"}`, in tablet pixels.
  Check every change here before you install it.

On the tablet, plugged in by USB (`root@10.11.99.1`, set `REMARKABLE` for another address):

- `scripts/install [--build] [--restart]`: copies `build/app` to the tablet. This is the first
  install; after that the launcher updates itself from Nap.
- `scripts/rmshot out.png [scale]`: a screenshot.
- `scripts/rminput tap x y` and `scripts/rminput pen x,y x,y …`: a finger tap or a pen stroke.

To try the tablet against a local Nap, forward it and point the launcher at it, then remove the
file afterwards:

```sh
ssh -N -R 8790:localhost:8790 root@10.11.99.1 &
ssh root@10.11.99.1 'echo http://localhost:8790 > /home/root/.local/share/nap/origin'
```

## Publish

Commit first, then `scripts/publish "What changed"`. It builds, pushes HEAD to `main` on Nap, and
uploads the zip with that commit as the app's `remarkable` target; Nap makes it the live build.
Each platform has its own builds and build numbers. Tablets pick it up the next time
the launcher opens, or with Check for updates. Tell the person the build number.

If publish answers `source_not_head`, someone pushed first: pull (`git pull nap main`), build,
and publish again. Never force-push `main`.

## Caveats on the tablet

- After a reboot, xovi has to be started again before AppLoad shows up.
- A reMarkable firmware update can break xovi and AppLoad until they are updated for it.
- Ink drawn through QML lags behind the tablet's own notebooks.
