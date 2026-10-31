# Nap roadmap

Nap is a private host for the things you and your agents make. See [README](README.md) for
how it works and [AGENTS](AGENTS.md) for development rules. This file lists
only open ideas. Remove an item when it ships.

## Soon

- A real profile editor for display name and username.
- Zip uploads.
- Clearer upload validation messages, for example about the root `index.html`.
- Polish for the replace/update confirmation.
- Better empty and ghost tile interactions.
- A "new site plops into the atlas" animation, driven by polling.
- A pan/zoom atlas with a bounded rubber-band sling-back.
- Better mobile and tablet layouts.

## Later

- Realtime for the dashboard. Collections and multiplayer channels are already live.
- Server-side room logic for channels (for example with the Dynamic Worker Loader), if a game ever needs an authoritative server.
- An Access-authenticated remote MCP server for agents without a shell (see
  `docs/plans/agent-first-mcp/`).
- Search, filter, and sort across sites.
- Lightweight usage analytics.
- An optional protection model for load-bearing tools, with open access as
  the default.
