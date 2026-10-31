import { createFileRoute } from "@tanstack/react-router";
import { ensureProfile, getEnv, getIdentity, json, listSites } from "~/lib/nap-server";

export const Route = createFileRoute("/api/sites")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);
        return json({ sites: await listSites(DB, identity), now: new Date().toISOString() });
      },
    },
  },
});
