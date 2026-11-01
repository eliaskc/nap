# Sites and artifacts on Nap

One rule: a slug gives a page its own host, and that makes it a site. Without a slug it is an artifact.

## Artifacts

- URL `https://{{rootDomain}}/artifact/<id>`, with a random id. The title is the name people see, so make it clear.
- It shows below a small Nap bar with the title, the owner, and a Share button for the owner. Do not add your own Share button. The page loads in a frame below the bar, so 100vh layouts and fixed elements work.
- The frame is a sandbox with an opaque origin (`location.origin` is "null"):
  - Use relative paths: `assets/app.js`, `fetch("data.json")`. Nap fixes root paths in HTML attributes (`src="/app.js"`), but not URLs that scripts build. For Vite, set `base: "./"`.
  - localStorage and sessionStorage are cleared on reload. Use collections (`data` topic) for anything that must last.
  - Cookies, service workers, and IndexedDB do not work.
  - Scripts, modules, fetch of the artifact's own files, forms, popups, downloads, clipboard, and fullscreen all work.

## Sites

- URL `https://<slug>.{{rootDomain}}`. Slugs are lowercase letters, numbers, and hyphens, up to 32 characters. `--site` without `--slug` makes one from the title; the owner can rename it later.
- Use a site for client-side routing, root-absolute URLs, service workers, storage that lasts, `nap.fetch`, or anything people come back to.
- Client-side routing (React Router, TanStack Router): put `{ "spa": true }` in `nap.json` at the root of the upload. Then a page path without a file, such as `/games/mini`, gets the root `index.html` and your router shows the page; missing files with an extension (`/assets/x.js`) stay 404. Use root-absolute asset paths (Vite's default `base: "/"`), so they also load on deep paths. Navigating inside the app keeps the page, so channels, voice calls, and live data stay connected.
- Add the Share button before `</body>`: `<script src="/_nap/share.js" defer></script>`. Only the owner sees it. `data-position="bottom-left"`, `"top-right"`, or `"top-left"` moves it (default bottom-right). Inside a frame it shows nothing, so it is safe to keep.
- A site with a build step keeps its source in a repo on Nap (`source` topic).

## Both

- Anyone who can view a page can publish new versions and restore old ones. Only the owner changes who can view it, renames, moves, transfers, or deletes it. The owner can move an artifact to Sites or back; the old URL redirects.
- Links that leave Nap should open in a new tab (`target="_blank"`); many sites refuse to load in a frame.
- If you bundle to one HTML file, add the `/_nap/` script tags after bundling. Bundlers fail on `/_nap/client.js` and `/_nap/share.js`, because those files only exist on Nap.
- In TypeScript, use Nap's own types for `window.nap` instead of declaring them: `curl -fsSL https://{{rootDomain}}/_nap/api/client.d.ts -o src/nap.d.ts`.
- A page that needs its own backend: publish only the static frontend, host the backend elsewhere, and point the frontend at its public URL.
