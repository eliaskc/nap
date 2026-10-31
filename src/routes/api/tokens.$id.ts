import { createFileRoute } from "@tanstack/react-router";
import { revokeAgentToken } from "~/lib/agent-auth";
import { ensureProfile, getEnv, getIdentity, json } from "~/lib/nap-server";
import { isCrossSite } from "~/lib/site-access";

/** DELETE /api/tokens/:id — disconnects one of the caller's agents. */
export const Route = createFileRoute("/api/tokens/$id")({
  server: {
    handlers: {
      DELETE: async ({ params, request }) => {
        if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);
        return revokeAgentToken(DB, identity.email, params.id);
      },
    },
  },
});
