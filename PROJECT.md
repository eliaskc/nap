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
- Native game servers: running a program that is not JavaScript, such as a game engine's
  dedicated server, as a channel's host. Channel servers run JavaScript in the channel's Durable
  Object and talk over WebSockets, which suits most browser games but not, for example, the real
  Counter-Strike 1.6 engine: that wants a native process, more memory and CPU than a Durable
  Object has, and UDP rather than TCP, whose head-of-line blocking makes a shooter stutter. The
  likely route is a Cloudflare Container per game room, behind a Durable Object that sleeps when
  the room empties, as the app signer does. Open questions:
  - Containers take only HTTP and WebSockets through the Worker, not UDP. Players' packets need a
    bridge over WebSockets, or WebRTC with the container as a peer through Cloudflare TURN
    (unreliable data channels; untested whether a container can be a TURN client).
  - Container images are fixed when Nap deploys, and Nap builds nothing for sites. So images
    would be chosen per instance (an extension, or container classes in its config) and
    reviewed, not uploaded by a site.
  - Cost and cold starts: an instance per active room, with the program and its files in the
    image.
- An Access-authenticated remote MCP server for agents without a shell (see
  `docs/plans/agent-first-mcp/`).
- Search, filter, and sort across sites.
- Lightweight usage analytics.
- An optional protection model for load-bearing tools, with open access as
  the default.
