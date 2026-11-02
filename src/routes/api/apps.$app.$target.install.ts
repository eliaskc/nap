import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { adHocEnabled, installLiveBuild } from "~/lib/apps";
import { signedIn, slugify } from "~/lib/nap-server";
import { fail, json, noStore, requireSameSite } from "~/server/http";
import { route } from "~/server/route";

/**
 * POST /api/apps/:app/:target/install — an itms-services link for the target's live build. The
 * link works for an hour: iOS fetches the manifest and the .ipa without the Access cookie.
 */
export const Route = createFileRoute("/api/apps/$app/$target/install")({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            if (!adHocEnabled()) return yield* fail(404, "Not found");
            const identity = yield* signedIn(request);
            const install = yield* installLiveBuild(
              identity.email,
              slugify(params.app),
              params.target.toLowerCase(),
              new URL(request.url).origin,
            );
            if (!install) return yield* fail(404, "No live build");
            return json({ install }, { headers: noStore });
          }),
        ),
    },
  },
});
