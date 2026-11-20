import { createFileRoute } from "@tanstack/react-router";
import { artifactPath, isLocalHostname } from "~/lib/nap-urls";
import { serveUploadedSite } from "~/lib/site-serving";
import { failText } from "~/server/http";
import { route } from "~/server/route";

/**
 * Local stand-in for <slug>.<content>. Artifacts redirect to /<slug>. Only on a local dev host:
 * anywhere else this would run a nap's own code on the dashboard's origin.
 */
export const Route = createFileRoute("/s/$slug/$")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        route(
          isLocalHostname(new URL(request.url).hostname)
            ? serveUploadedSite(params.slug, params._splat ?? "", request, {
                accessPath: `/s/${encodeURIComponent(params.slug)}/_nap/access`,
                dashboardUrl: "/",
                artifactUrl: (key) => `${new URL(request.url).origin}${artifactPath(key)}`,
              })
            : failText(404, "Not found"),
        ),
    },
  },
});
