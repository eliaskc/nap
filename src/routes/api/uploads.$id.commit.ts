import { createFileRoute } from "@tanstack/react-router";
import { commitDirectUpload } from "~/lib/direct-uploads";
import { getEnv, getIdentity, json } from "~/lib/nap-server";
import { isCrossSite } from "~/lib/site-access";

/** POST /api/uploads/:id/commit — checks the uploaded files and makes the version live. */
export const Route = createFileRoute("/api/uploads/$id/commit")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
        const env = getEnv();
        const identity = getIdentity(request);
        const published = await commitDirectUpload(env, identity, params.id, "dashboard");
        if (published instanceof Response) return published;
        const { slug, kind, title, currentVersion } = published;
        return json({ ok: true, site: { slug, kind, title, currentVersion } });
      },
    },
  },
});
