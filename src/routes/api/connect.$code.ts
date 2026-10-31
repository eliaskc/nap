import { createFileRoute } from "@tanstack/react-router";
import { decideDeviceRequest, describeDeviceRequest } from "~/lib/agent-auth";
import { ensureProfile, getEnv, getIdentity, json } from "~/lib/nap-server";
import { isCrossSite } from "~/lib/site-access";

/** The /connect page. GET shows an agent's sign-in request; POST approves or denies it. */
export const Route = createFileRoute("/api/connect/$code")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { DB } = getEnv();
        await ensureProfile(DB, getIdentity(request));
        return describeDeviceRequest(DB, params.code);
      },
      POST: async ({ params, request }) => {
        // Approving gives an agent a token for this person. Only this origin may ask: a JSON
        // body forces a CORS preflight, and naps on other hosts are same-site, not same-origin.
        if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
        if (!request.headers.get("content-type")?.includes("application/json")) {
          return json({ error: "Expected JSON" }, { status: 415 });
        }
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);
        const body = (await request.json().catch(() => ({}))) as { action?: unknown };
        return decideDeviceRequest(DB, identity, params.code, body.action);
      },
    },
  },
});
