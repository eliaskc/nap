import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { signedIn, slugify } from "~/lib/nap-server";
import { updateSiteAccess } from "~/lib/site-access";
import { fail } from "~/server/http";
import { route } from "~/server/route";

export const Route = createFileRoute("/api/sites/$slug/access")({
  server: {
    handlers: {
      PATCH: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const slug = slugify(params.slug);
            if (!slug) return yield* fail(400, "Missing site slug");
            const body = (yield* Effect.promise(() => request.json())) as {
              visibility?: unknown;
              emails?: unknown;
            };
            return yield* updateSiteAccess(identity, slug, body);
          }),
        ),
    },
  },
});
