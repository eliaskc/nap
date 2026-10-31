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
- Nap never builds apps either: agents upload unsigned iOS builds with their commit, and only the `SIGNER` container holds the signing certificate. Never sign on a laptop or in CI. Templates for app repos are in `templates/app`.
- Nap never runs Git or builds sites. Agents push source to a site's Artifacts repo and publish the build with its commit; `src/lib/sources.ts` checks that commit. Use the `cf` CLI to inspect or clean up Artifacts repos.
- Keep production private. `workers_dev` and `preview_urls` are bypass URLs that can avoid Cloudflare Access. They must be `false` in production:

```ts
workersDev: { enabled: false, previewsEnabled: false }
```

Temporary testing may enable them, but revert before deploying.

- Nap has no Wrangler config. Production deployment and D1 migration history belong to Alchemy; local dev and the HTTP tests run `local*` Alchemy stages. Read the infrastructure section in `README.md` before changes to production resources. Preserve the live database and bucket; review the plan for replacements.
- Code on Access-bypassed paths (`/_nap/drafts`, `/_nap/api/*`, `/_nap/frame/*`, `/_nap/install/*`, `/_nap/enroll/*`) must never call `getIdentity()` or `ensureProfile()`.

## Documentation

`README.md` covers architecture, the security model, and operations. `src/content/instructions/` is the contract for agents that publish to Nap (an index plus topics), and `skills/nap/SKILL.md` is the skill that points agents to it. Keep UI details, limits, endpoint lists, and file-by-file layouts out of the README; the code is the reference for those. Update the docs only when a concept, security rule, operation, or command changes.

## Commands

```sh
pnpm dev
pnpm dev:local
pnpm run build
pnpm test
pnpm test:http
pnpm test:apps
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
