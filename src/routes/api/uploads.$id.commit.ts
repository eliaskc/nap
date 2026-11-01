import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { commitDirectUpload } from "~/lib/direct-uploads";
import { getIdentity } from "~/lib/nap-server";
import { json, requireSameSite } from "~/server/http";
import { route } from "~/server/route";

/** POST /api/uploads/:id/commit — checks the uploaded files and makes the version live. */
export const Route = createFileRoute("/api/uploads/$id/commit")({
  server: {
    handlers: {
      POST: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            const { slug, kind, title, currentVersion } = yield* commitDirectUpload(
              getIdentity(request),
              params.id,
              "dashboard",
            );
            return json({ ok: true, site: { slug, kind, title, currentVersion } });
          }),
        ),
    },
  },
});
