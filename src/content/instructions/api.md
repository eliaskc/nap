# The Nap HTTP API

Everything the publish script does, with curl. All paths are under `https://{{rootDomain}}`. Send the token as `authorization: Bearer $TOKEN`, and set TOKEN in the same command so it does not show in your output: in bash or zsh `TOKEN="${NAP_TOKEN:-$(cat ~/.config/nap/{{rootDomain}}/token)}"`, in fish `set TOKEN (set -q NAP_TOKEN; and echo $NAP_TOKEN; or cat ~/.config/nap/{{rootDomain}}/token)`.

## Sign in

1. `curl -sS -X POST https://{{rootDomain}}/_nap/api/auth/device -H 'content-type: application/json' -d '{"client":"Claude Code on elias-mbp"}'`. Name yourself and the machine.
2. Give the user `verification_uri_complete` and `user_code`, and ask them to approve and check that the codes match. Open the link for them if you can.
3. Poll every `interval` seconds, in one shell loop for up to 10 minutes: `curl -sS -X POST https://{{rootDomain}}/_nap/api/auth/token -H 'content-type: application/json' -d '{"device_code":"<device_code>"}'`. `authorization_pending`: poll again. `slow_down`: wait 5 seconds more. `access_denied` or `expired_token`: stop and tell the user.
4. On success, save the token at once and write which Nap it is for:
   `mkdir -p ~/.config/nap/{{rootDomain}} && (umask 077 && printf '%s' '<token>' > ~/.config/nap/{{rootDomain}}/token)`, and
   `{"url":"https://{{rootDomain}}","org":"{{orgName}}","email":"<email>"}` in `~/.config/nap/{{rootDomain}}/nap.json`.

Never print the token or put it in a project. In a sandbox that cannot write there, ask the user to set NAP_TOKEN. The token publishes as the user: it creates pages, chooses access for new ones, publishes versions of pages the user can view, and comments. It cannot change access, rename, or delete. A 401 with code `invalid_token` means it was disconnected: delete it and sign in again. Code `inactive` means the user must open https://{{rootDomain}} first.

## Publish

- One HTML file: `curl -sS https://{{rootDomain}}/_nap/api/naps -H "authorization: Bearer $TOKEN" -H 'content-type: text/html' --data-binary @bundle.html --url-query 'title=Q3 report'`
- A site: add `--url-query slug=team-map`, or `kind=site` for a slug made from the title.
- Several files: multipart, each file with its path: `-F 'title=Team map' -F kind=site -F 'files=@dist/index.html;filename=index.html' -F 'files=@dist/assets/app.js;filename=assets/app.js'`
- Access for a new page: `access=private`, `access=everyone`, or `access=selected` with `emails=a@x.com,b@x.com`. Without it the page gets the default ({{defaultAccess}}).
- New version: send the same to `/_nap/api/naps/<id>/versions` with `message=What changed`. URL, access, and settings stay. On someone else's page, send `expectedVersion=<currentVersion>` from `GET /_nap/api/naps/<id>`. Without it Nap answers `expected_version_required`; a 409 means someone published in between, so read the page again and merge.
- The response has id, url, version, access, and a message that says who can see it. Tell the user who can see it.
- Uploads through Nap take up to 25 MB. Larger, or more than a few files: direct uploads, below.

## Direct uploads (up to 1 GB and 100,000 files)

1. `POST /_nap/api/uploads` with JSON `{"files":[{"path":"index.html","size":1234}],"title":"..."}` listing every file (exact sizes in bytes), plus kind, slug, access, and emails for a new page, or `"id"` and `"message"` for a new version. The response has uploadId, commitUrl, and a url and headers for each file of the first page (up to 1,000).
2. PUT each file to its url with exactly those headers: `curl -sS --fail -X PUT -T img/a.png -H 'content-type: image/png' '<url>'`. The URLs last an hour. Do not send the token to them.
3. While the response has a `nextPage` URL, GET it with the token when you reach it: it has the next page of `files` and its own `nextPage` (null after the last page).
4. POST to commitUrl with the token. If it says files are missing, PUT them again and POST again.

## Read and change pages

- `GET /_nap/api/naps`: the user's pages and those shared with them by name: id, title, url, kind, owner, role. Pages shared with everyone are not listed but work by id. The id is in the URL: `/artifact/<id>` or `<id>.{{rootDomain}}`.
- `GET /_nap/api/naps/<id>`: one page, with currentVersion and source.
- `GET /_nap/api/naps/<id>/files` lists the live files, and `/files/<path>` returns one. Add `?version=<version>` for an older version.
- `GET /_nap/api/naps/<id>/versions`: history, newest first.
- `POST /_nap/api/naps/<id>/restore` with `{"version":"..."}`: only when the user asks. On someone else's page, also send `"expectedCurrentVersion"`.

## Comments (artifacts)

- `GET /_nap/api/naps/<id>/comments?status=open`: each with its quote (selected text), body, author, and replies. Read them when the user asks you to address feedback.
- `POST .../comments` with `{"body":"...","quote":"exact text","path":"/"}`; leave out quote for the whole page. `POST .../comments/<comment id>/replies` with `{"body":"..."}`.
- `PATCH .../comments/<comment id>` with `{"resolved":true}`. After publishing a fix, reply with what you changed, then resolve. Never resolve only because you read it.

## Limits

Through Nap: 25 MB and 1,000 files per upload. Direct uploads: 1 GB and 100,000 files. 20 uploads a minute.
