import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { appsEnabled, listApps, testFlightConfig, testFlightUrl } from "~/lib/apps";
import { signedIn } from "~/lib/nap-server";
import { json, noStore } from "~/server/http";
import { route } from "~/server/route";

/**
 * GET /api/apps — the app with its launcher's live build, and its TestFlight link. Everyone who
 * can sign in.
 */
export const Route = createFileRoute("/api/apps")({
  server: {
    handlers: {
      GET: ({ request }) =>
        route(
          Effect.gen(function* () {
            yield* signedIn(request);
            if (!appsEnabled()) {
              return json({ apps: [], enabled: false, testFlight: null });
            }
            const apps = yield* listApps(new URL(request.url).origin);
            const testFlight = testFlightConfig();
            return json(
              {
                apps,
                enabled: true,
                testFlight: testFlight
                  ? {
                      app: testFlight.app,
                      target: "launcher",
                      url: testFlightUrl(testFlight.appStoreId),
                    }
                  : null,
              },
              { headers: noStore },
            );
          }),
        ),
    },
  },
});
