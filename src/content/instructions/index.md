# Nap at {{rootDomain}}

Nap hosts small web things for {{orgName}}: prototypes, demos, reports, docs, little tools, dashboards, games. Anything that builds to static files with an index.html fits. Pages can also store data and talk to each other live through Nap. There is no server code, and no secrets at request time.

You build and publish yourself. Do not hand routine build or publish steps back to the user.

This page covers the common case. Read a topic below when you need it.

## Build

- Make it feel finished and easy to open cold: a clear title, enough context on the page, responsive, real empty states, no console errors.
- Follow the system light or dark mode; the Nap bar does. With plain CSS, use `color-scheme: light dark` and `@media (prefers-color-scheme: dark)`. With a `.dark` class theme (Tailwind, shadcn), put this in `<head>`:
  `<script>(()=>{const m=matchMedia("(prefers-color-scheme: dark)"),r=document.documentElement,s=()=>{r.classList.toggle("dark",m.matches);r.style.colorScheme=m.matches?"dark":"light"};s();m.addEventListener("change",s)})()</script>`
- Never upload servers, API routes, SSR, `.env` files, or secrets. Treat everything on Nap as internal, not secret.

## Artifact or site

- **Artifact** (the default): one page to look at or use, such as a report, a prototype, or a one-off tool. It lives at `https://{{rootDomain}}/artifact/<random id>` below a small Nap bar with a Share button.
- **Site**: something people come back to, at `https://<slug>.{{rootDomain}}`. Make a site when the user asks for one, or when the page needs client-side routing, root-absolute URLs, or storage that lasts across reloads. Read the `sites` topic first.

## Sign in and publish

Use the publish script. It needs Node 20 or newer; without Node, read the `api` topic.

    curl -fsSL https://{{rootDomain}}/_nap/api/publish.mjs -o /tmp/nap-publish.mjs
    node /tmp/nap-publish.mjs login                          # once per machine
    node /tmp/nap-publish.mjs bundle.html --title "Q3 report"  # artifact: one HTML file or a folder with index.html
    node /tmp/nap-publish.mjs dist --title "Team map" --slug team-map   # site
    node /tmp/nap-publish.mjs dist --update <id> --message "Add the weekly chart"

- `login` prints a link and a code. Give both to the user and ask them to approve. It waits up to 10 minutes, so use a long timeout. It saves the token in `~/.config/nap/{{rootDomain}}/token`. Never print the token or put it in a project. Exit code 3 means you need to sign in, and 4 means the user must open https://{{rootDomain}} first.
- A site with a build step (React, Vite, TypeScript, a bundler) keeps its source in a repo on Nap. Publish it with `--source <repo dir>`, and read the `source` topic first.
- Keep the id from the output. New versions go to the same URL. Nap keeps every version, and nothing changes in place.
- Before you change a page you did not make in this session, read its live files first (`api` topic). On a page someone else owns, add `--expected-version <its current version>` so you do not overwrite their changes.

## Who can see it

<!-- if private -->

New pages are private: only the owner sees them. Add `--access everyone` (everyone at {{orgName}}) or `--access selected --emails a@x.com,b@x.com` when the user wants others to see it. If they want to send the link to someone, they must share it first.

<!-- /if -->
<!-- if everyone -->

New pages are shared with everyone at {{orgName}}. Use `--access selected --emails a@x.com,b@x.com`, or `--access private` for only the owner, when the user wants that.

<!-- /if -->

Access only applies when you create a page. After that, only the owner changes it, with the Share button.

**Every time you hand over a link, say who can see it**, from the "Who can see it" line of the output. If only the owner can see it, tell the user to share it with the Share button before they send the link.

## Topics

Read one with `curl -fsSL https://{{rootDomain}}/_nap/api/instructions/<topic>`.

- `sites`: sites in detail, how artifacts run in their frame, and the Share button.
- `source`: source repos for sites with a build step, and changing a site that has one.
- `data`: collections that save JSON documents, with live updates (`nap.db`).
- `channels`: multiplayer, presence, and messages between the people on a page (`nap.channel`).
- `voice`: a live audio call between the people on a page (`nap.voice`).
- `fetch`: reading public APIs from other origins (`nap.fetch`).
- `api`: the HTTP API without the script: sign-in, publishing, files, versions, restore, comments, and limits.
- `drafts`: publishing without a token through a claim link the user opens.
{{extensionTopics}}
<!-- if apps -->
- `apps`: native apps, one repo with a folder per platform (the topic lists this Nap's: iOS, installed from TestFlight, and others). Use them only when the user asks for a native app, such as on the phone.
<!-- /if -->

When Nap cannot do something (custom domains, passwords, server logic, scheduled jobs), do not work around it. Tell the user to ask {{admin}}.
