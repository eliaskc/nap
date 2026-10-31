import { createFileRoute } from "@tanstack/react-router";
import { ACTIVE_DAYS, listAgentTokens } from "~/lib/agent-auth";
import { ensureProfile, getEnv, getIdentity, json } from "~/lib/nap-server";

/** GET /api/tokens — the caller's connected agents. */
export const Route = createFileRoute("/api/tokens")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);
        return json(
          { tokens: await listAgentTokens(DB, identity.email), activeDays: ACTIVE_DAYS },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
