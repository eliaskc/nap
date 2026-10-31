import { createFileRoute } from "@tanstack/react-router";
import { appsEnabled } from "~/lib/apps";
import { addDevice, listDevices } from "~/lib/devices";
import { isCrossSite } from "~/lib/site-access";
import { ensureProfile, getEnv, getIdentity, json } from "~/lib/nap-server";

/**
 * GET /api/devices — every registered iPhone.
 * POST /api/devices { udid, name } — registers an iPhone and signs the live builds for it.
 */
export const Route = createFileRoute("/api/devices")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);
        return json(
          { devices: await listDevices(DB) },
          { headers: { "cache-control": "no-store" } },
        );
      },
      POST: async ({ request }) => {
        if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
        if (!appsEnabled()) return json({ error: "Not found" }, { status: 404 });
        const env = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(env.DB, identity);
        const body = (await request.json().catch(() => ({}))) as { udid?: unknown; name?: unknown };
        return addDevice(
          env,
          identity.email,
          typeof body.udid === "string" ? body.udid : "",
          typeof body.name === "string" ? body.name : "",
        );
      },
    },
  },
});
