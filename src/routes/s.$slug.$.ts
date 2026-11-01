import { createFileRoute } from "@tanstack/react-router";
import { ARTIFACT_PATH } from "~/lib/nap-urls";
import { serveUploadedSite } from "~/lib/site-serving";
import { route } from "~/server/route";

/** Local stand-in for <slug>.<root>. Artifacts redirect to /artifact/<slug>. */
export const Route = createFileRoute("/s/$slug/$")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        route(
          serveUploadedSite(params.slug, params._splat ?? "", request, {
            accessPath: `/s/${encodeURIComponent(params.slug)}/_nap/access`,
            dashboardUrl: "/",
            artifactUrl: (key) => `${new URL(request.url).origin}${ARTIFACT_PATH}/${key}`,
          }),
        ),
    },
  },
});
