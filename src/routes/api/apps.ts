import { createFileRoute } from "@tanstack/react-router";
import { appsEnabled, listApps } from "~/lib/apps";
import { ensureProfile, getEnv, getIdentity, json } from "~/lib/nap-server";

/** GET /api/apps — every app with its targets and live builds. Everyone who can sign in. */
export const Route = createFileRoute("/api/apps")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);
        if (!appsEnabled()) return json({ apps: [], enabled: false });
        return json(
          { apps: await listApps(DB, new URL(request.url).origin), enabled: true },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
