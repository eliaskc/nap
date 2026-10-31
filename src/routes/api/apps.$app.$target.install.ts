import { createFileRoute } from "@tanstack/react-router";
import { appsEnabled, installLiveBuild } from "~/lib/apps";
import { isCrossSite } from "~/lib/site-access";
import { ensureProfile, getEnv, getIdentity, json, slugify } from "~/lib/nap-server";

/**
 * POST /api/apps/:app/:target/install — an itms-services link for the target's live build. The
 * link works for an hour: iOS fetches the manifest and the .ipa without the Access cookie.
 */
export const Route = createFileRoute("/api/apps/$app/$target/install")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
        if (!appsEnabled()) return json({ error: "Not found" }, { status: 404 });
        const env = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(env.DB, identity);
        const install = await installLiveBuild(
          env,
          identity.email,
          slugify(params.app),
          params.target.toLowerCase(),
          new URL(request.url).origin,
        );
        if (!install) return json({ error: "No live build" }, { status: 404 });
        return json({ install }, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
