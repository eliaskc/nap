import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { listSites, signedIn } from "~/lib/nap-server";
import { json } from "~/server/http";
import { route } from "~/server/route";

export const Route = createFileRoute("/api/sites")({
  server: {
    handlers: {
      GET: ({ request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const sites = yield* listSites(identity);
            return json({ sites, now: new Date().toISOString() });
          }),
        ),
    },
  },
});
