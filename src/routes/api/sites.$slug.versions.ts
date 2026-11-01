import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { signedIn, slugify } from "~/lib/nap-server";
import { canViewSite, getSiteOwner } from "~/lib/site-access";
import { listVersions, restoreVersion } from "~/lib/versions";
import {
  fail,
  json,
  noStore,
  readJsonObject,
  requireJsonBody,
  requireSameSite,
} from "~/server/http";
import { route } from "~/server/route";

/**
 * GET /api/sites/:slug/versions — the version history, newest first. Anyone who can view it.
 * POST /api/sites/:slug/versions — { version, expectedCurrentVersion? } makes an earlier
 * version live again. Anyone who can view it, not for GitHub-managed sites.
 */
export const Route = createFileRoute("/api/sites/$slug/versions")({
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
            return json({ versions: yield* listVersions(slug) }, { headers: noStore });
          }),
        ),
      POST: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            yield* requireJsonBody(request);
            const identity = yield* signedIn(request);
            const body = yield* readJsonObject(request);
            return yield* restoreVersion(identity.email, slugify(params.slug), body);
          }),
        ),
    },
  },
});
