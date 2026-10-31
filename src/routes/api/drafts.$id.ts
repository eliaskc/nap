import { createFileRoute } from "@tanstack/react-router";
import { claimDraft, describeDraft } from "~/lib/drafts";
import { ensureProfile, getEnv, getIdentity, json } from "~/lib/nap-server";
import { isCrossSite } from "~/lib/site-access";

export const Route = createFileRoute("/api/drafts/$id")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);
        return describeDraft(DB, identity, params.id);
      },
      POST: async ({ params, request }) => {
        if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
        if (!request.headers.get("content-type")?.includes("application/json")) {
          return json({ error: "Expected JSON" }, { status: 415 });
        }
        const env = getEnv();
        const identity = getIdentity(request);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        return claimDraft(env, identity, params.id, body);
      },
    },
  },
});
