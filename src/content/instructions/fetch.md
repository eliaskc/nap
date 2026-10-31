# Fetching other origins on Nap (nap.fetch)

Browsers block pages from reading most APIs on other origins. A site (not an artifact) can read them through Nap.

- Load `<script src="/_nap/client.js"></script>`, then `const response = await nap.fetch("https://api.example.com/today.json")`. It returns a normal Response.
- List the allowed hosts in `nap.json` at the root of the upload: `{ "fetch": ["api.example.com", "*.example.org"] }`. Nap only fetches those hosts, only GET over https, and sends no cookies or login. Other URLs throw a NapError with status 403.
- Responses are cached for about five minutes and limited to 5 MB. Only for public data, never anything that needs a login or secret.
- APIs that already allow other origins are faster with the browser's own fetch.
