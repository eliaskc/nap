# Naps: the frame, names, and their own host

Every nap has a name: a random id, or one chosen with `--name` (lowercase letters, numbers, and hyphens, up to 32 characters; Nap's own paths such as `api` or `connect` are taken). The owner can rename it later; the old URL redirects. By default a nap runs in Nap's frame at `https://{{rootDomain}}/<name>`. A few run on their own host instead.

## In the frame (the default)

- URL `https://{{rootDomain}}/<name>`. The title is what people see, so make it clear.
- It shows below a small Nap bar with the title, the owner, and a Share button for the owner. Do not add your own Share button. The owner can turn the bar off in Nap; then the nap fills the window. Either way it loads in a frame, so 100vh layouts and fixed elements work.
- The frame is a sandbox with an opaque origin (`location.origin` is "null"):
  - Use relative paths: `assets/app.js`, `fetch("data.json")`. Nap fixes root paths in HTML attributes (`src="/app.js"`), but not URLs that scripts build. For Vite, set `base: "./"`.
  - localStorage and sessionStorage are cleared on reload. Use collections (`data` topic) for anything that must last.
  - Cookies, service workers, IndexedDB, and pointer lock do not work. Client-side routing works with hash URLs (`#/games/mini`), not with real paths.
  - Scripts, modules, fetch of the nap's own files, `nap.fetch`, forms, popups, downloads, clipboard, and fullscreen all work.
- People comment on it from the Nap bar (`api` topic).

## On its own host

- URL `https://<name>.{{rootDomain}}`: a real origin. Publish with `--own-host`, with or without `--name`; without one, Nap makes one from the title.
- Use it only when the nap needs what the frame cannot do: localStorage or IndexedDB that lasts, cookies, service workers, client-side routing with real paths, root-absolute URLs that scripts build, or pointer lock. This is for now: later every nap will run in a frame with its own origin.
- Client-side routing (React Router, TanStack Router): put `{ "spa": true }` in `nap.json` at the root of the upload. Then a page path without a file, such as `/games/mini`, gets the root `index.html` and your router shows the page; missing files with an extension (`/assets/x.js`) stay 404. Use root-absolute asset paths (Vite's default `base: "/"`), so they also load on deep paths. Navigating inside the app keeps the page, so channels, voice calls, and live data stay connected.
- It has no Nap bar unless the owner turns it on. Add the Share button before `</body>`: `<script src="/_nap/share.js" defer></script>`. Only the owner sees it. `data-position="bottom-left"`, `"top-right"`, or `"top-left"` moves it (default bottom-right). In the frame it shows nothing, so it is safe to keep.
- No comments.

## People

<!-- if avatars -->

Everyone on Nap has a name and a look: one of 7 shapes in one of 7 colours, a pair that is only theirs on this Nap. Show people with them instead of inventing names, colours, or avatars. With `<script src="/_nap/client.js"></script>`:

- `await nap.me()` is the person viewing the page: `{ email, name, shape, color }`.
- `await nap.people()` is everyone on this Nap; `nap.people(["a@x.com"])` only those people. Same fields.
- `<nap-avatar shape="clover" color="green" name="Anna Lindqvist" size="32"></nap-avatar>` draws someone's avatar; `nap.avatar(person, { size: 32 })` returns the same as an `<svg>`. `initials="false"` leaves out the letters.
- `nap.looks` has the shapes and colours (`shapePaths` are SVG paths in a 100 × 100 box, `colorValues` hex colours) for pages that draw people themselves, such as on a canvas. A page may restyle the looks to fit its design, as long as every shape and colour still maps to a different one.

<!-- /if -->
<!-- if !avatars -->

Everyone on Nap has a name they chose. Show people by that name instead of inventing names. This Nap has no avatars: do not give people shapes, colours, or pictures; their name (or initials) is enough. With `<script src="/_nap/client.js"></script>`:

- `await nap.me()` is the person viewing the page: `{ email, name }`.
- `await nap.people()` is everyone on this Nap; `nap.people(["a@x.com"])` only those people. Same fields.

<!-- /if -->

## Both

- Anyone who can view a nap can publish new versions and restore old ones. Only the owner changes who can view it, renames it, moves it between the frame and its own host, turns the bar on or off, changes its type, transfers, or deletes it. A move keeps the name, and the old URL redirects.
- A nap with a build step keeps its source in a repo on Nap (`source` topic).
- Links that leave Nap should open in a new tab (`target="_blank"`); many sites refuse to load in a frame.
- If you bundle to one HTML file, add the `/_nap/` script tags after bundling. Bundlers fail on `/_nap/client.js` and `/_nap/share.js`, because those files only exist on Nap.
- In TypeScript, use Nap's own types for `window.nap` instead of declaring them: `curl -fsSL https://{{rootDomain}}/_nap/api/client.d.ts -o src/nap.d.ts`.
- A nap that needs its own backend: publish only the static frontend, host the backend elsewhere, and point the frontend at its public URL.
