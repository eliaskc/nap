import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { appsEnabled, listApps, napApp, testFlightConfig, testFlightUrl } from "~/lib/apps";
import { signedIn } from "~/lib/nap-server";
import { json, noStore } from "~/server/http";
import { route } from "~/server/route";

/**
 * GET /api/apps — the app with each platform's live build, and the iOS TestFlight link. Everyone
 * who can sign in.
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
                      app: napApp(),
                      target: "ios",
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
