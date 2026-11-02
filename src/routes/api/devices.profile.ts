import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { adHocEnabled } from "~/lib/apps";
import { enrollmentProfile } from "~/lib/devices";
import { signedIn } from "~/lib/nap-server";
import { fail } from "~/server/http";
import { route } from "~/server/route";

/**
 * GET /api/devices/profile — the .mobileconfig that adds the signed-in person's iPhone. Open it in
 * Safari on the iPhone. See devices.ts.
 */
export const Route = createFileRoute("/api/devices/profile")({
  server: {
    handlers: {
      GET: ({ request }) =>
        route(
          Effect.gen(function* () {
            if (!adHocEnabled()) return yield* fail(404, "Not found");
            const identity = yield* signedIn(request);
            const profile = yield* enrollmentProfile(identity.email, new URL(request.url).origin);
            return new Response(profile, {
              headers: {
                "content-type": "application/x-apple-aspen-config",
                "content-disposition": 'attachment; filename="add-iphone.mobileconfig"',
                "cache-control": "no-store",
              },
            });
          }),
        ),
    },
  },
});
