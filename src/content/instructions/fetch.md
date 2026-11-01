# Fetching other origins on Nap (nap.fetch)

Browsers block pages from using most APIs on other origins. A site (not an artifact) can call them through Nap.

- Load `<script src="/_nap/client.js"></script>`, then `const response = await nap.fetch("https://api.example.com/today.json")`. It returns a normal Response.
- List the allowed hosts in `nap.json` at the root of the upload: `{ "fetch": ["api.example.com", "*.example.org"] }`. Nap only fetches those hosts, only over https. Other URLs throw a NapError with status 403.
- `nap.fetch(url, { method, headers, body })` takes GET, HEAD, POST, PUT, PATCH, and DELETE, with a body of up to 256 KB, for example `{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }`.
- Nap sends only what the page passes: never the viewer's cookies or login. Headers Nap must control (`cookie`, `host`, `cf-*`, `x-forwarded-*`, and the like) are dropped.
- GET responses without headers of the page's own are cached for about five minutes. Anything else is not cached. Responses are limited to 5 MB.
- Never put a secret in a page: everyone who can view the site can read it. `nap.fetch` is for public APIs and anonymous tokens the API hands out to any visitor.
- APIs that already allow other origins are faster with the browser's own fetch.
