import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { signedIn, slugify } from "~/lib/nap-server";
import { transferOwnership } from "~/lib/site-access";
import { fail, readJsonObject, requireJsonBody, requireSameSite } from "~/server/http";
import { route } from "~/server/route";

/** PUT /api/sites/:slug/owner — { email } gives the nap to someone else. Owner only. */
export const Route = createFileRoute("/api/sites/$slug/owner")({
  server: {
    handlers: {
      PUT: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            yield* requireJsonBody(request);
            const identity = yield* signedIn(request);
            const slug = slugify(params.slug);
            if (!slug) return yield* fail(400, "Missing site slug");
            const body = yield* readJsonObject(request);
            return yield* transferOwnership(identity, slug, body);
          }),
        ),
    },
  },
});
