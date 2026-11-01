import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { getIdentity } from "~/lib/nap-server";
import { listPeople } from "~/lib/people";
import { json } from "~/server/http";
import { route } from "~/server/route";

/** GET /api/people — the caller, and known Nap users in the caller's domain, for share suggestions. */
export const Route = createFileRoute("/api/people")({
  server: {
    handlers: {
      GET: ({ request }) =>
        route(
          listPeople(getIdentity(request)).pipe(
            Effect.map((people) =>
              json(people, { headers: { "cache-control": "private, max-age=60" } }),
            ),
          ),
        ),
    },
  },
});
