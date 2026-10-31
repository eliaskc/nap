import { createFileRoute } from "@tanstack/react-router";
import { getEnv } from "~/lib/nap-server";
import { ARTIFACT_PATH } from "~/lib/nap-urls";
import { serveUploadedSite } from "~/lib/site-serving";

/** Local stand-in for <slug>.<root>. Artifacts redirect to /artifact/<slug>. */
export const Route = createFileRoute("/s/$slug/$")({
  server: {
    handlers: {
      GET: async ({ params, request }) =>
        serveUploadedSite(getEnv(), params.slug, params._splat ?? "", request, {
          accessPath: `/s/${encodeURIComponent(params.slug)}/_nap/access`,
          dashboardUrl: "/",
          artifactUrl: (key) => `${new URL(request.url).origin}${ARTIFACT_PATH}/${key}`,
        }),
    },
  },
});
