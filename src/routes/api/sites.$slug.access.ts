import { createFileRoute } from "@tanstack/react-router";
import { ensureProfile, getEnv, getIdentity, json, slugify } from "~/lib/nap-server";
import { updateSiteAccess } from "~/lib/site-access";

export const Route = createFileRoute("/api/sites/$slug/access")({
  server: {
    handlers: {
      PATCH: async ({ params, request }) => {
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);

        const slug = slugify(params.slug);
        if (!slug) return json({ error: "Missing site slug" }, { status: 400 });

        const body = (await request.json()) as { visibility?: unknown; emails?: unknown };
        return updateSiteAccess(DB, identity, slug, body);
      },
    },
  },
});
