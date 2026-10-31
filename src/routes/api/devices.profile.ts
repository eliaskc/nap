import { createFileRoute } from "@tanstack/react-router";
import { appsEnabled } from "~/lib/apps";
import { enrollmentProfile } from "~/lib/devices";
import { ensureProfile, getEnv, getIdentity, json } from "~/lib/nap-server";

/**
 * GET /api/devices/profile — the .mobileconfig that adds the signed-in person's iPhone. Open it in
 * Safari on the iPhone. See devices.ts.
 */
export const Route = createFileRoute("/api/devices/profile")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!appsEnabled()) return json({ error: "Not found" }, { status: 404 });
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);
        const profile = await enrollmentProfile(DB, identity.email, new URL(request.url).origin);
        return new Response(profile, {
          headers: {
            "content-type": "application/x-apple-aspen-config",
            "content-disposition": 'attachment; filename="add-iphone.mobileconfig"',
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});
