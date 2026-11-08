# Nap

A private host for the things you and your agents make, for a small group of
people. You upload built files. A site can
also keep its source in a Git repo on Nap, so agents can change it later.

- **Dashboard:** `<root domain>`
- **Sites:** `<slug>.<root domain>`
- **Artifacts:** `<root domain>/artifact/<id>`
- **Local:** `/s/<slug>/` and `/artifact/<id>`

The app uses TanStack Start, React, Tailwind CSS v4, and shadcn/ui with Base
UI. A Cloudflare Worker serves it. Private R2 stores the site files, and D1
stores the metadata and collections. Cloudflare Access protects the dashboard
and the hosted sites.

This README covers the architecture, the security model, and operations. For
UI behaviour, limits, and endpoint details, read the code.

## Development

Use pnpm, Bun for Alchemy, and Node 24+ for the tests.

```sh
pnpm install
pnpm infra:login     # Configure the local Alchemy profile named nap
pnpm dev             # Fully local stage: D1, R2, and Durable Objects in workerd, no login
pnpm dev:remote      # Personal stage on Cloudflare (needs pnpm infra:login)
pnpm run build       # Bundle and type-check app and infrastructure
pnpm test
pnpm test:http       # HTTP checks against a new local stage, no login
pnpm test:voice      # Two Chrome pages in a voice call on a new local stage
pnpm test:sources    # Source repos against real Artifacts (test namespace; nap profile)
```

Stages named `local*` keep their Alchemy state in `.alchemy/` and run every
resource in workerd, so they need no Cloudflare credentials. Their `SOURCES`
binding is remote, because Artifacts has no local emulation: it fails
without credentials, and Nap answers source requests with 503. `test:http`
starts a new local stage per run with `alchemy dev` and removes it again.

For `pnpm infra:login`, select the stored Cloudflare API credentials and the
existing GitHub CLI login. Alchemy stores the credentials in your local
profile, outside the repository; you do not need a `.env`. Use a Cloudflare
token that is scoped to the instance's account and zone.
It needs access to Workers, D1, R2, Artifacts, DNS, Access, and the Secrets Store
bindings of the shared state store. Keep credentials out of source control
and logs.

## Run your own Nap

An instance is a domain on Cloudflare plus a private config repository. This
repository holds no instance settings; the config repository holds them, with
the secrets and a deploy workflow that deploys this code with them.

1. **Cloudflare.** Add your domain as a zone. The dashboard is at the root
   domain you choose and sites at `<slug>.<root domain>`, so the root domain
   is the zone apex or one level below it (Universal SSL covers one wildcard
   level). Apps need the Workers Paid plan, for the signer Container.
2. **Zero Trust.** Create a team; its domain
   (`https://<team>.cloudflareaccess.com`) is your `accessIssuer`. Under
   Authentication, add the login methods people will use: One-time PIN works
   for any email, and Google or your company's identity provider work too.
   Nap only checks the email: `people` lists emails, and `@example.com` lets
   in everyone at a domain.
3. **API token.** Create one for the deploys with these permissions on your
   account: Workers Scripts, Workers KV Storage, Workers R2 Storage, D1,
   Workers Containers, Workers Observability, Artifacts, Secrets Store,
   Access: Apps and Policies, Access: Organizations, Identity Providers, and
   Groups, and Access: Service Tokens (all Edit), plus Workers Tail and Account
   Settings (Read). On your zone: Workers Routes and DNS (Edit), Zone and Zone
   Settings (Read). Workers Containers is only needed with apps.
4. **R2 signing token.** Create a user API token with only "Workers R2
   Storage Bucket Item Write" on the bucket `nap-sites` (the bucket can not
   exist yet). Its id is `NAP_R2_ACCESS_KEY_ID`, and the SHA-256 of its value
   is `NAP_R2_SECRET_ACCESS_KEY` (see "R2 signing token" below).
5. **Config repository.** Create a private repository with:
   - `instance/`, copied from `instance.example/`. In `config.ts`, set your
     domain, organisation name, admin, `defaultAccess`, and `apps: null`
     unless you set up apps (step 7). In `production.ts`, set the account id,
     zone id and name, `accessIssuer`, and `people`. Leave `databaseId` empty.
   - `.github/workflows/deploy.yml`, copied from
     `infra/config-repo-deploy.yml`.
   - Secrets `CLOUDFLARE_API_TOKEN`, `NAP_R2_ACCESS_KEY_ID`, and
     `NAP_R2_SECRET_ACCESS_KEY`, and the variable `CLOUDFLARE_ACCOUNT_ID`.
6. **First deploy.** Push, or run `gh workflow run deploy.yml`. Alchemy
   creates its state store, the database, the bucket, DNS, Access, and the
   Worker. Put the `databaseId` from its output in `instance/production.ts`
   and push; from then on, `pnpm plan` checks the live resources against it.
   Open the root domain, sign in, and give your agent
   `https://<root domain>/_nap/api/instructions`, or install the skill in
   `skills/nap`.
7. **Apps (optional).** With an Apple Developer account, make these by hand
   (Nap never creates them): an Apple Distribution certificate, an App Store
   Connect team key with the Admin role, an explicit App ID, an App Store
   profile for it named as `testFlight.profileName`, an app record in App
   Store Connect with that bundle id (`testFlight.appStoreId` is its Apple
   ID), and an internal tester group with access to all builds.

   Set `apps` in `instance/config.ts`. Add the secrets
   `NAP_APPLE_SIGNING_PEM` (the certificate's private key and certificate in
   one PEM) and `NAP_ASC_PRIVATE_KEY` (the `.p8`), and the variables
   `NAP_ASC_KEY_ID` and `NAP_ASC_ISSUER_ID`.

8. **Voice (optional).** For calls on naps (`nap.voice`), create a TURN key:
   `cf realtime turn keys create --name nap`. Its `uid` is the variable
   `NAP_TURN_KEY_ID` and its `secret` is the secret `NAP_TURN_KEY_API_TOKEN`.
   Without them, calls use STUN only and fail on some networks.
9. **Extensions (optional).** Add APIs of your own to the kit pages get, in
   `instance/extensions/<name>/` (see "Extensions" below). Their secrets go in
   one secret, `NAP_EXTENSION_SECRETS`, as a JSON object.
10. **Notifications (optional).** Set `notifications: true` in
    `instance/config.ts`, and pages and apps can send them (`nap.notify`).
    Browsers get them once the person turns them on with the bell; Nap makes
    the web push keys itself. For the iOS app, create an APNs key in the Apple
    developer account (Keys, Apple Push Notifications service, Sandbox &
    Production, team scoped): the `.p8` is the secret `NAP_APNS_PRIVATE_KEY`
    and its key ID the variable `NAP_APNS_KEY_ID`.
11. **Icon (optional).** Nap's icon (`brand/AppIcon.icon`, made in Icon
    Composer) is the icon of the dashboard and of new app launchers. For your
    own, put an Icon Composer icon at `instance/icon/AppIcon.icon` and run
    `node scripts/icons.mjs instance/icon` on a Mac. Commit both the icon and
    the `instance/icon/web/` it writes. An app repo made before keeps its icon
    in `ios/Launcher/Resources/`.

To stay on a release instead of `main`, set the config repository variable
`NAP_REF` to a tag of this repository. To add someone, put their email in
`people` and push. An account that already has Access policies for its people
can use them instead: `accessPolicies` takes their ids, and then Nap makes no
Access policies of its own. To work on Nap against
your instance, check out both repositories side by side and link the folder:
`ln -s ../<config repo>/instance instance`.

## Infrastructure

`alchemy.run.ts` declares the Cloudflare resources: the Worker, storage, DNS,
and Access. Bindings are inferred from the Worker declaration.

This repository knows no instance. Each instance keeps its settings in
`instance/` (copy `instance.example/`; the folder is gitignored):
`instance/config.ts` has the domain, organisation and apps, and
`instance/production.ts` the account, zone, Access, and people. Its Access
application lets in the people listed there, with any login method of the
Zero Trust team. Alchemy keeps its state in the account's state store.

```sh
pnpm infra:inventory # Read-only inspection; private snapshots in backups/
pnpm plan            # Inspect the proposed changes
pnpm deploy          # Apply infrastructure and application changes
pnpm logs
```

CI here only builds and tests, with `instance.example/`. Each instance has a
private config repository with its `instance/` folder, its secrets, and a
deploy workflow that checks out this repository, adds `instance/`, and runs
`alchemy deploy`. It runs on pushes to the config repository, daily, and on
demand, so a change here reaches an instance by its next run. Cloudflare's native Git build integration must stay disconnected, so
that nothing deploys outside Alchemy.

Rules for production:

- Keep R2 private and both Worker bypass URLs disabled.
- Review every plan for replacements. The live database and bucket must never
  be recreated. Keep database backups private.
- Alchemy owns the production migrations in `migrations/`. Do not apply them
  by hand.

## Sites and artifacts

Both are rows in `sites`, and `kind` says how each one is served. They share
`sites.slug`, so the owner can move a nap between the two, and the old URL
redirects.

- **Sites** have their own host, `<slug>.<root>`. Each one has its own origin,
  so sites cannot read each other's data unless one allows it (below), and they
  get real browser storage.
  They are for things that people come back to.
- **Artifacts** are at `<root>/artifact/<id>`. The id is random, not made
  from the title, and cannot be renamed. They are quick pages. On the
  dashboard an artifact shows to its owner and the people it invites; one
  shared with everyone shows to others once they have opened it.

A site that moves to Artifacts gets a random id; the R2 files and rows move
to the new key (`src/lib/rekey.ts`). The old slug stays in `nap_redirects`.
It only redirects, from both `<slug>.<root>` and `<root>/artifact/<slug>`,
and is never shown. A live nap with that slug always wins over a redirect. An
artifact that moves to Sites keeps its id as its host until the owner renames
it.

New naps are private. The owner can invite people or open a nap
to everyone who can sign in; Cloudflare Access is still the outer limit.
Anyone who can view a nap can also publish new versions of it and restore
old ones (`canViewSite` in `src/lib/site-access.ts`). Versions are immutable,
so a bad upload is one restore away. Only the owner changes who can view it,
its settings, its URL, or its owner, or deletes it. A transfer goes only to
someone who has used Nap, and the previous owner stays invited. Sites
can show an optional Nap toolbar (`src/lib/nap-toolbar.ts`). It serves the
site in a frame on the same host, so there is only one Access cookie.

### Collections

Each nap has JSON document collections in D1 (`src/lib/site-data.ts`), with
a browser client at `/_nap/client.js`. Every write raises the document's
`version` and gives it the site's next change number, `seq`. Conditional
writes compare `version`, so an app can refuse to overwrite an edit it has
not seen. Deletes stay as tombstones, so the changes feed (rows after a
`seq`) also reports them. Read from `seq` 0, the feed leaves tombstones out,
because a page loading a collection from scratch has never seen those
documents. It sends up to 1000 changes a request, so most collections load in
one.

Live updates go through one Durable Object per nap (`src/lib/site-live.ts`),
named by its slug. D1 stays the only store: the Worker commits the write, then
hands the change to the object, which sends it to every page with a socket
open on `/_nap/live`. The object holds nothing but hibernating WebSockets.
The Worker checks access before it opens a socket, and the object checks
again on every send and closes the sockets of people who lost access. The
client polls the changes feed when it connects and, more slowly, while
connected, so a missed message only delays an update.

A site can let another site's pages use some of its collections, in the `nap.json` of its live
version (`"data": { "allow": { "<other site>": ["<collection>"] } }`). Those pages call
`/_nap/data/@<site>/<collection>` on their own host, so Access works as for their own data; Nap
checks that the person can view the site that owns the data and that its live manifest allows the
calling site and collection. There is no live socket for another site's collections.

### Channels

Channels (`src/lib/site-channel.ts`) are for multiplayer pages: one Durable
Object per nap and channel name, named `<slug>/<channel>`. Pages connect to
`/_nap/channel/<name>`, send messages to each other, and each keep a small
presence state. Nothing is stored: presence lives in each socket's
attachment, so it survives hibernation. The object stamps every message with
the sender from the identity the Worker checked, rate-limits each socket, and
rechecks access at most once a minute while messages flow. Without a server,
pages agree on the longest-connected peer as the host for shared state.

#### Channel servers

With `channelServers: true` (Workers Paid plan; always on local stages), a
site can name its own JavaScript for channels in its live `nap.json`
(`"servers": { "game-*": "server.js" }`), and that code is the channel's
authoritative host instead of a page (`src/lib/channel-server.ts`). The
channel object stays in charge: it keeps the sockets, identity, rate limits,
and access checks, and loads the file from the site's version in R2 into a
Dynamic Worker (Worker Loader), keyed by slug, version, and path. It runs the
code as a Durable Object facet, a child of the channel object with its own
SQLite storage that cannot reach the channel object's. The Dynamic Worker has
no bindings and no network (`globalOutbound: null`): it only hears the joins,
leaves, presence, and `to: "server"` messages the channel object passes it,
one at a time, and answers with the messages to send.

The server starts when the first person joins, with the version live then,
and stops when the last one leaves; a new version takes over in the next
session, and the facet's storage carries over. While it runs, a timer ticks
it at its own rate (up to 30 Hz) or simply keeps the object awake, so the
server keeps its memory; a running server costs Durable Object duration and
one Dynamic Worker request per tick. Errors go to Workers Logs and to the
pages as `error` events. `pnpm test:http` runs it end to end
(`scripts/channel-servers/test-local.mjs`).

Native game servers (an engine's dedicated server over UDP, such as
Counter-Strike's) do not fit this: see `PROJECT.md`.

### Voice

`nap.voice` (in the client script) puts the people on a channel in one audio
call. Each pair of pages connects directly with WebRTC, and the channel only
carries the offers, answers, and candidates between them, so Nap never sees
the audio. Direct connections fail on many mobile and office networks, so
`/_nap/rtc` (`src/lib/site-rtc.ts`) gives people who can view the nap
short-lived Cloudflare TURN credentials, made from the instance's TURN key.
The key stays in the Worker. A connection to every other person keeps calls
to about eight people.

### Fetches

Pages can call public APIs on other origins through `/_nap/fetch`
(`src/lib/site-fetch.ts`), for APIs that send no CORS headers: sites on their own host,
artifacts below their frame token. The page lists the hosts in a `nap.json` at the root of its
live version, so each publish decides what it may reach. Nap checks that the person can view
the page, fetches only over https from those hosts (and never
Nap's own), and checks every redirect against the list. Pages choose the method, a small body,
and headers (in `x-nap-fetch-headers`, so they stay apart from the browser's own); Nap sends
nothing of the viewer's: no cookies, no Access headers. Plain GETs are cached at the edge for a
few minutes; anything with a body or the page's own headers is not, since the cache keys on the
URL alone. Responses are size limited and carry a sandbox CSP, because they are served from the
site's own origin.

The same `nap.json` (`src/lib/site-manifest.ts`, cached per immutable version) can mark a site
as a single-page app: with `"spa": true`, a page path that has no file gets the root
`index.html`, so client-side routers work on reloads and deep links.
Artifacts cannot use it.

### Notifications

With `notifications: true`, a page calls `nap.notify({ title, body, open })` (`/_nap/notify`,
`src/lib/notifications.ts`), and an app the same through the agent API with its token. Nap sends
it to everyone else who can view the page, never the sender: to browsers that turned it on
(web push, with a VAPID key pair Nap makes and keeps in `nap_keys`, and payloads encrypted to
each browser) and to phones with the app (APNs, with the instance's key). Where they go is
`push_targets`, by email; dead subscriptions and uninstalled apps are dropped when a push
service says so. A tap opens a page on the Nap's own domains only. Each send is logged in
`notifications`, which the per-sender and per-page rate limits count.

### The artifact viewer

`src/lib/artifact-viewer.ts` serves `/artifact/<slug>` behind Access. It shows
the Nap bar and an iframe that is sandboxed without `allow-same-origin`, so
the artifact runs in an opaque origin. It cannot read the dashboard or other
artifacts, and the dashboard's same-origin checks refuse its requests.

The frame cannot depend on the Access cookie. Each viewer load creates a
short-lived frame token (only its hash is stored), and the frame loads its
files and the `/_nap/*` data endpoints from `/_nap/frame/<token>/`. Access
bypasses that path, so the Worker checks the token and the person's current
access on each request. The token is the credential: it appears only in the
frame URL and is not sent in the referrer.

Tokens last 12 hours. While the page is open, the Nap bar renews its token
through `/artifact/<slug>/_nap/frame`, which Access protects, so a dashboard
left open on a screen keeps working, and someone Access no longer lets in
loses the frame when the token runs out.

### Extensions

A deployment can add APIs to the kit without changing Nap: each folder in
`instance/extensions/<name>/` becomes `nap.<name>` for pages, an endpoint at
`/_nap/ext/<name>/*`, and an instructions topic. The contract is in
`nap.extension.ts`; the build bundles extensions into the Worker and
`client.js` (`scripts/lib/extensions.ts`). Nap routes requests from sites,
artifact frames, and local dev servers (`src/lib/extensions.ts`), checks that
the person can view the page, and gives the extension only the secrets it
declares from `NAP_EXTENSION_SECRETS`, and a cache of its own in the bucket
(`extension-cache/<name>/`, deleted after a week; the Workers Cache API does not
work behind Access). An extension is server code with the
deployment's secrets, so it is reviewed like Nap's own; pages still hold no
secrets and run no server code. Tests next to an extension
(`instance/extensions/*/*.test.mjs`) run with `pnpm test`.

### Comments

Viewers can select text in an artifact and comment on it. The Nap bar loads
`/_nap/comments.js`, a React and shadcn bundle built from `src/comments`. The
frame loads `comments-frame.js`, which finds the quoted text, draws the
highlights, and reports positions, hovers, and clicks to the bar over
`postMessage`. The bar draws avatar pins in the margin, or a slim tab on the
frame's edge when the artifact has no margin, and popovers whose theme follows
the artifact's background. Comments live in the D1 `comments` table and are
anchored by the quote with some text before and after it, so they survive new
versions while the quote is still there. The API is
`/artifact/<slug>/_nap/comments`; the bar polls it every 30 seconds.

Artifacts should use relative URLs. Apps that need root paths, client-side
routing, or lasting browser storage should be sites.

## Agent publishing

The agent guide is in `src/content/instructions/`. `GET /_nap/api/instructions`
serves its index without a login: enough for the common case, with a list of
topics at `/_nap/api/instructions/<topic>`. Each instance fills in its own
domain, organisation, and default access, and leaves out what it has turned
off. The dashboard's "Copy prompt" copies the index. There is no CLI and no
MCP; an agent needs only `curl`.

`skills/nap/SKILL.md` is the agent skill: it tells agents when to suggest Nap,
how to find the user's Naps (`~/.config/nap/<host>/`, which `login` writes),
and to read that Nap's instructions. Install it from this repository; each Nap
also serves it at `/_nap/api/skill`.

New naps get the instance's `defaultAccess` (`private` or `everyone`) unless
the publisher picks another. Every publish response says who can see the page,
so agents always pass that on with the link.

- **Tokens** (`src/lib/agent-auth.ts`). An agent signs in with a device code,
  like the OAuth device flow, and the user approves it at `/connect`, behind
  Access. D1 stores only hashes. A token acts as its owner, with less power:
  it can publish new naps, update any nap its owner can view, and choose who
  can view a new nap (up to everyone who can sign in), but it cannot change
  access on an existing nap, rename, or delete them. On a nap someone else
  owns, a token must send the
  live version it read, so an agent cannot overwrite a change it has not
  seen. A token stops
  working when its owner has not used Nap through Access for some time, so
  people that Access removes lose their tokens. People disconnect their
  agents in the dashboard.
- **Comments.** Tokens can read and write comments on artifacts their owner
  can view:
  `GET`/`POST /_nap/api/naps/<id>/comments`, `POST …/comments/<cid>/replies`,
  and `PATCH …/comments/<cid>` with `{ "resolved": true }`.
- **Direct uploads.** Uploads through the Worker are held in memory, so they
  stay small. Larger uploads go straight to R2: Nap checks the token (or the
  Access identity, for the dashboard) and the file list, picks the URL and a
  new version id, and returns one presigned PUT URL per file. Each URL writes
  one object under that new version, with a signed type and size, for an
  hour. A commit checks the files in R2 and moves the live pointer, so a URL
  can never change a live version. `src/content/publish.mjs`, served at
  `/_nap/api/publish.mjs`, does the steps for agents.
- **Claim links.** Agents without a token upload a draft to `/_nap/drafts`.
  The user opens the claim link behind Access, checks the preview, and
  publishes the draft. Drafts expire.

Agents get everything they need from `GET /_nap/api/instructions`.

### Paths without Access

These are the only paths that bypass Access. Each one has its own Access
application in `alchemy.run.ts`, and the Worker checks a credential itself:

| Path            | Access app            | Credential                                  |
| --------------- | --------------------- | ------------------------------------------- |
| `/_nap/drafts`  | `DraftUploadAccess`   | none; rate-limited, and drafts need a claim |
| `/_nap/api/*`   | `AgentApiAccess`      | agent token                                 |
| `/_nap/frame/*` | `ArtifactFrameAccess` | frame token                                 |

Code on these paths must never call `getIdentity()` or `ensureProfile()`.
The Access headers are not set there, and a token must not keep its owner
active.

## Versions

Uploads are immutable versions under `sites/<slug>/versions/<id>/`.
`sites.current_version` points to the live one. Every upload adds a row to
`versions` with its source and parent, whether it comes from the dashboard,
an agent, or a claim (old rows also say GitHub). A restore moves the pointer
and copies nothing.

### R2 signing token

Presigned URLs are signed with the S3 credentials of an R2 API token that has
only "Workers R2 Storage Bucket Item Write" on `nap-sites`. Its access key id
is the token id, and its secret access key is the SHA-256 of the token value.
Deploys read them from the config repository secrets `NAP_R2_ACCESS_KEY_ID` and
`NAP_R2_SECRET_ACCESS_KEY`; a production plan or deploy fails without them. To
rotate, create a new token with the same scope, update both secrets, deploy,
then delete the old token. Other stages have no token, and the dashboard falls
back to uploads through the Worker.

## Source repos

A site can keep its source in a Cloudflare Artifacts repo, one per site, in the
namespace bound as `SOURCES` (`nap-sites` in production). The agent
instructions ask for one when a site has a real build step or will be worked
on for long; plain HTML sites and artifacts do without. Nap never runs Git
and never builds anything:

```text
agent → Nap token → short-lived Git token → git clone/push to Artifacts
agent → local build → publish with sourceCommit → Nap checks the commit → R2 + D1
```

- **Tokens.** The agent API mints read or write tokens for one repo that last
  15 minutes, for anyone who can view the site. Only the owner adds a repo to
  an existing site. A new site can get its repo with its first direct upload
  (`createSource`), so its first version is built from a commit; the upload
  holds the repo until it is committed, and an expired upload deletes it.
  Nap logs who got a token, never the token. Nobody has a lasting Git
  credential. Clones that `publish.mjs` makes or sets up name it as their Git
  credential helper for the repo, so plain git and jj ask it for a new token
  each time; the token is never stored.
- **Publishing.** `sites.source_repo` names the repo. A new version of such a
  site must name its commit, which must be the head of `main` and contain the
  live version's commit. Artifacts allows force-pushes, so this check, not
  Git, keeps published work from being dropped. Dashboard uploads and claim
  links are off for these sites. Nap cannot prove that a build came from its
  commit, the same trust as any agent upload.
- **Restores, renames, deletes.** A restore moves the live pointer and leaves
  the repo alone. A rename keeps the repo name. Deleting a site leaves its
  repo, as it leaves its files in R2.

Moving a site's source in: the owner's agent publishes with
`publish.mjs --update <id> --source <dir>`, which creates the repo, pushes
the history, and publishes with the commit. For a folder of another repo it
splits the history out (`git subtree split --prefix=<folder>`), creates the
repo (`publish.mjs source <id> --create`), pushes, and publishes with
`--source-commit`. Sites that were published through GitHub Actions
became ordinary sites in migration 0016 and move in the same way.

## Apps

Native apps. A Nap has one app (`napConfig.apps.app`): an Artifacts repo
(`app-<slug>`, in `SOURCES`) with a folder per platform. Each platform is a
target of the app, with its own builds, build numbers, and live build, and a
launcher that holds every app made for it. The platforms are iOS, SwiftUI
apps in one launcher that people install from TestFlight (`napConfig.apps.ios`),
and reMarkable, QML apps in one AppLoad launcher for the reMarkable 2 tablet
(`napConfig.apps.remarkable`). Nap never builds apps:

```text
agent → app repo (Artifacts) → ios/: Tuist project → xcodebuild without signing on a Mac
agent → upload the platform's zip with sourceCommit → Nap checks the commit
Nap (iOS) → signer container (rcodesign) → App Store .ipa in R2 → App Store Connect → TestFlight
Nap (reMarkable) → the zip as it came, with its SHA-256 → tablet (Nap token) → update itself
```

- **Repo.** `ios/` holds the iOS launcher (`ios/Launcher/`) and one module per
  app (`ios/Apps/<slug>/`); `remarkable/` holds the reMarkable launcher
  (`remarkable/launcher/`, QML and a Go backend) and one folder per app
  (`remarkable/apps/<slug>/`). The template leaves out the platforms a Nap has
  off. Everyone who can sign in can push to the repo and
  publish every platform.
- **Publishing.** A build names its platform and its commit, which must be
  the head of `main` and contain the commit of that platform's live build, as
  with sites. Nap keeps the upload and what it made of it under
  `apps/<app>/builds/<id>/` and moves `app_targets.live_build`. What happens
  between upload and going live is the platform's own step (`PLATFORMS` in
  `src/lib/apps.ts`).
- **Signing.** The `SIGNER` binding is a Cloudflare Container built from
  `containers/signer`. It gets the Apple Distribution key and certificate as an
  environment variable, has no internet access, and signs without a timestamp.
  It checks that the build is an arm64 iOS device build and that the App
  Store profile covers the app record's bundle id. The profile comes from the
  App Store Connect API (team key) and is cached in R2 at `apps/_signing/`.
  Deploys need Docker to build the image.
- **TestFlight.** Each iOS build is uploaded to App Store Connect with the build
  upload API before it goes live. Its build number goes above every build App
  Store Connect has. Apple then processes it for internal testers; Nap asks
  Apple how far it got when someone opens Get the app, at most every few
  seconds per build, and keeps the state on the build. TestFlight builds need
  an app icon and `ITSAppUsesNonExemptEncryption`; the template has both.
- **reMarkable.** Nap keeps the zipped AppLoad folder as it was uploaded
  and records its SHA-256 (`app_builds.sha256`). The first install on a
  tablet is over USB from the repo (`remarkable/scripts/install`); the tablet
  needs xovi and AppLoad. After that the launcher signs in with the device
  flow, asks `GET /_nap/api/apps/<app>/targets/remarkable` for the live build
  when it opens, and downloads it from `…/targets/remarkable/builds/<id>/download`
  with its token, checking the SHA-256.
- **Apple's side.** Nap uploads builds, reads the App Store profile, turns
  capabilities on, and adds testers. The App ID, the profile, and the app
  record are made by hand; Nap never creates them.
- **Capabilities.** An app declares Info.plist usage strings and capabilities
  in its `app.json`; the template writes the capabilities into the launcher's
  Info.plist as `NapCapabilities`, by app. When it signs, Nap reads them (the
  signer's `/inspect`), turns the ones it can on for the App ID through App
  Store Connect, makes a new App Store profile if any was off, and signs with
  the basic entitlements plus those of the granted capabilities.
  `apps.testFlight.capabilities` limits which it turns on. What a build cannot
  have (those needing setup in the developer account, or Apple refused) the
  signer writes into Info.plist as `NapCapabilityWarnings`, and the launcher
  shows them on the app that asked. Nap never turns capabilities off.
- **Get the app.** One sheet on the dashboard, opened from the bar (whose label
  is the person's next step), the nudge above the list, or a link to `/app`.
  It shows each platform's live build with the apps inside it, which the
  publish script reads from each app's `app.json` (`app_builds.contents`).
- **Testers.** Internal testers must be App Store Connect users. From the
  dashboard's Get the app, anyone signed in to Nap gives their Apple Account
  email; Nap invites it to the team with the Marketing role and access to the
  TestFlight app only, and once Apple lists them as a user, adds them to the
  app's internal group (the one named Nap, else the first). Existing users go
  straight into the group. Nap learns that an invite was accepted only by
  asking Apple when the person looks. The team API key needs the Admin role
  for this.
- **Data.** Apps cannot pass Access, so they sign in with the agent device
  flow and use `/_nap/api/naps/<id>/data/*`, `/live`, `/channel/<name>`, and `/rtc`
  with the token. These are the site's own data and channel endpoints under
  the token's identity; like frame requests, they do not count as using
  Nap.
- **Secrets.** `NAP_APPLE_SIGNING_PEM` and `NAP_ASC_PRIVATE_KEY` are
  config repository secrets; `NAP_ASC_KEY_ID` and `NAP_ASC_ISSUER_ID` are
  its variables. The Cloudflare API token needs Containers edit access.

`pnpm test:apps` runs the whole path against an Artifacts test namespace with
a real Xcode build, the real certificate, and the instance's TestFlight app
(see the script for setup).
