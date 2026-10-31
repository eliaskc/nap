import { createFileRoute } from "@tanstack/react-router";
import { ensureProfile, getEnv, getIdentity, json, slugify } from "~/lib/nap-server";
import { isCrossSite, transferOwnership } from "~/lib/site-access";

/** PUT /api/sites/:slug/owner — { email } gives the nap to someone else. Owner only. */
export const Route = createFileRoute("/api/sites/$slug/owner")({
  server: {
    handlers: {
      PUT: async ({ params, request }) => {
        if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
        if (!request.headers.get("content-type")?.includes("application/json")) {
          return json({ error: "Expected JSON" }, { status: 415 });
        }
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);

        const slug = slugify(params.slug);
        if (!slug) return json({ error: "Missing site slug" }, { status: 400 });

        const body = (await request.json().catch(() => ({}))) as { email?: unknown };
        return transferOwnership(DB, identity, slug, body);
      },
    },
  },
});
