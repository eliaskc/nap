import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { signedIn, slugify } from "~/lib/nap-server";
import { canViewSite, getSiteOwner, isSameEmail } from "~/lib/site-access";
import { countLoads, listVisitors } from "~/lib/visits";
import { fail, json, noStore } from "~/server/http";
import { route } from "~/server/route";

/**
 * GET /api/sites/:slug/visitors — who has opened it, most recent first, and the three counts
 * (visits.ts): people, views (the number the dashboard shows and ranks by), and loads. Only the
 * owner.
 */
export const Route = createFileRoute("/api/sites/$slug/visitors")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const slug = slugify(params.slug);
            const site = slug ? yield* getSiteOwner(slug) : null;
            if (!site || !(yield* canViewSite({ ...site, slug }, identity.email))) {
              return yield* fail(404, "Not found");
            }
            if (!isSameEmail(site.createdByEmail, identity.email)) {
              return yield* fail(403, "Only the owner can see who visited");
            }
            const visitors = yield* listVisitors(slug, site.createdByEmail);
            const { loads, lastLoadedAt } = yield* countLoads(slug);
            return json(
              {
                visitors,
                people: visitors.length,
                views: visitors.reduce((sum, visitor) => sum + visitor.visits, 0),
                loads,
                lastLoadedAt,
              },
              { headers: noStore },
            );
          }),
        ),
    },
  },
});
