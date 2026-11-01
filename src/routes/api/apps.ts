import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { appsEnabled, listApps } from "~/lib/apps";
import { signedIn } from "~/lib/nap-server";
import { json, noStore } from "~/server/http";
import { route } from "~/server/route";

/** GET /api/apps — every app with its targets and live builds. Everyone who can sign in. */
export const Route = createFileRoute("/api/apps")({
  server: {
    handlers: {
      GET: ({ request }) =>
        route(
          Effect.gen(function* () {
            yield* signedIn(request);
            if (!appsEnabled()) return json({ apps: [], enabled: false });
            const apps = yield* listApps(new URL(request.url).origin);
            return json({ apps, enabled: true }, { headers: noStore });
          }),
        ),
    },
  },
});
