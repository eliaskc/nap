# Nap Development Guidelines

Instructions for agents working on the Nap platform codebase itself. Not for agents creating sites hosted on Nap.

## Context

Nap is a TanStack Start app on Cloudflare Workers. It provides a private dashboard for uploading static sites. Files live in R2; metadata, profiles, and live version pointers live in D1.

## Stack

- Package manager: `pnpm`; Bun runs Alchemy infrastructure scripts
- Framework: TanStack Start + TanStack Router
- Runtime: Cloudflare Workers
- UI: React, Tailwind CSS v4, shadcn/ui with Base UI
- Infrastructure: `alchemy.run.ts`, with pinned Alchemy and Effect versions
- Bindings: `DB` = D1, `SITES` = R2, `LIVE` = Durable Object for live collection updates, `CHANNELS` = Durable Object per multiplayer channel, `SOURCES` = Cloudflare Artifacts namespace with one Git repo per site that keeps its source in Nap (sites with a build step; never artifacts) and one per app, `SIGNER` = Cloudflare Container (`containers/signer`) that signs iOS builds, inferred from `NapWorker`

## Rules

- Use shadcn CLI commands for shadcn components; do not hand-copy component source.
- Use Base UI, semantic tokens, `gap-*`, and `size-*` conventions.
- Treat uploaded versions as immutable. Store files at:

```txt
sites/<slug>/versions/<version_id>/<path>
```

- Serve from D1 `sites.current_version`; never overwrite live files in place.
- Use email as the stable identity key.
- Nap never builds apps either: agents upload unsigned iOS builds with their commit, and only the `SIGNER` container holds the signing certificate. Never sign on a laptop or in CI. Nap uploads TestFlight builds to App Store Connect itself. Templates for app repos are in `templates/app`.
- Nap never runs Git or builds sites. Agents push source to a site's Artifacts repo and publish the build with its commit; `src/lib/sources.ts` checks that commit. Use the `cf` CLI to inspect or clean up Artifacts repos.
- Keep production private. `workers_dev` and `preview_urls` are bypass URLs that can avoid Cloudflare Access. They must be `false` in production:

```ts
workersDev: { enabled: false, previewsEnabled: false }
```

Temporary testing may enable them, but revert before deploying.

- Nap has no Wrangler config. Production deployment and D1 migration history belong to Alchemy; local dev and the HTTP tests run `local*` Alchemy stages. Read the infrastructure section in `README.md` before changes to production resources. Preserve the live database and bucket; review the plan for replacements.
- Code on Access-bypassed paths (`/_nap/drafts`, `/_nap/api/*`, `/_nap/frame/*`, `/_nap/install/*`, `/_nap/enroll/*`) must never call `getIdentity()` or `ensureProfile()`.

## Server code (Effect)

Server code is written with Effect 4 (`effect@4.1.x`, the version Alchemy uses). Effect's own
guide ships in `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/`; read it rather
than older Effect 2/3 docs. The UI and the small scripts Nap serves to sites as source
(`share-widget.ts`, `nap-toolbar.ts`, `src/comments/`) are not Effect code.

- `src/server/` holds the infrastructure: services for the bindings (`Database` for D1, `Storage`
  for R2, `Settings`, `RateLimiter`, `Background`, and the optional bindings in `bindings.ts`),
  `http.ts` for responses and errors, and `runtime.ts`, which provides the services and runs
  handlers. Domain code in `src/lib/` uses these; it never touches `env` or `ctx` itself.
- Write functions with `Effect.fn("name")(function* (...) { ... })` (`Effect.fnUntraced` for small
  internal helpers). Pure functions stay plain functions.
- A handler is an `Effect<Response, ...>`. Anything the client should see as an error fails with
  `HttpError` (`return yield* fail(404, "Not found")`); the runtime turns it into the JSON
  response. Never return error `Response`s through success values, and never use `Response |
T` unions: fail instead. Infrastructure errors (`DatabaseError`, `StorageError`,
  `SourceRepoError`, `AppleError`) stay typed and become a logged 500 unless caught.
- SQL stays plain SQL: `db.first<Row>(sql, ...params)`, `db.all`, `db.run` (returns
  `{ changes }`), and `db.batch([sql(...), ...])` for transactions. Catch unique violations with
  `Effect.catchIf((e) => e.isConstraint, ...)`.
- Decode untrusted input with `Schema` (`decodeOr` in `http.ts`), keeping the existing error
  messages; agents depend on them.
- Work after the response goes through `inBackground(effect, label)`, never `ctx.waitUntil`.
- Log with `Effect.logInfo(message).pipe(Effect.annotateLogs({ ... }))`. The runtime writes JSON
  lines, which Workers Logs indexes. Never log tokens.
- The Worker (`src/worker.ts`) runs handlers with `respond(env, effect, ctx)`; API routes in
  `src/routes/api` with `route(effect)` from `src/server/route.ts`; tests with `runNap` or
  `respond` and fake bindings.

## The site client (src/client)

`src/client/` is `window.nap`, the script every site loads from `/_nap/client.js`: collections,
channels, voice, `nap.fetch`, `nap.me`. It runs in visitors' browsers, on every site.

- It is TypeScript, bundled by `scripts/lib/client-bundle.ts` into one classic script that the
  Worker serves (the `virtual:nap-client` module in `vite.config.ts`). Pages call it as plain
  JavaScript, so its API stays plain Promises and callbacks.
- `src/client/api.d.ts` is its public API. The client is typed against it, and Nap serves it as
  `/_nap/client.d.ts` and `/_nap/api/client.d.ts`. Change it with the instructions in
  `src/content/instructions/`.
- Voice is in two parts. `voice.ts` (in client.js) is the object pages get; it loads
  `voice-engine.ts`, served as `/_nap/client-voice.js?v=<hash>`, the first time a page calls
  `nap.voice()`, so pages without voice stay small. The engine is written with Effect, like the
  server: a call is one scoped fiber, and what it opens is released when the scope closes.
- `tests/client.test.mjs` runs the built script against fake browser globals,
  `tests/voice-engine.test.mjs` the engine against fake media, and `pnpm test:voice` two Chrome
  pages in a real call against a local stage.

## Documentation

`README.md` covers architecture, the security model, and operations. `src/content/instructions/` is the contract for agents that publish to Nap (an index plus topics), and `skills/nap/SKILL.md` is the skill that points agents to it. Keep UI details, limits, endpoint lists, and file-by-file layouts out of the README; the code is the reference for those. Update the docs only when a concept, security rule, operation, or command changes.

## Commands

```sh
pnpm dev
pnpm dev:remote
pnpm run build
pnpm test
pnpm test:http
pnpm test:apps
pnpm test:testflight
pnpm infra:inventory
pnpm plan
pnpm run deploy
pnpm dlx shadcn@latest add <component>
```

Run before handoff:

```sh
pnpm run build
```

## Product notes

- Store site order, not absolute tile positions.
- Collections are live through the `LIVE` Durable Object; D1 stays the only store. Elsewhere, polling is enough for near-realtime until proven otherwise.
- Add more Durable Objects/WebSockets only when needed.
- Keep Nap simple and private-first.
