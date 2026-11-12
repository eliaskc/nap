import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { nextPageUrl, signDirectUploadPage } from "~/lib/direct-uploads";
import { getIdentity } from "~/lib/nap-server";
import { json, noStore, requireSameSite } from "~/server/http";
import { route } from "~/server/route";

/** GET /api/uploads/:id/urls?offset=<n> — the next page of presigned URLs for a direct upload. */
export const Route = createFileRoute("/api/uploads/$id/urls")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            const offset = Number(new URL(request.url).searchParams.get("offset") ?? "");
            const page = yield* signDirectUploadPage(
              getIdentity(request),
              params.id,
              "dashboard",
              offset,
            );
            return json(
              { ...page, nextPage: nextPageUrl("/api", params.id, page.nextOffset) },
              { headers: noStore },
            );
          }),
        ),
    },
  },
});
