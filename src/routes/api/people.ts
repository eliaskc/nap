import { createFileRoute } from "@tanstack/react-router";
import { getEnv, getIdentity, json } from "~/lib/nap-server";
import { listPeople } from "~/lib/people";

/** GET /api/people — the caller, and known Nap users in the caller's domain, for share suggestions. */
export const Route = createFileRoute("/api/people")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { DB } = getEnv();
        return json(await listPeople(DB, getIdentity(request)), {
          headers: { "cache-control": "private, max-age=60" },
        });
      },
    },
  },
});
