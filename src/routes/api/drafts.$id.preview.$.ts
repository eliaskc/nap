import { createFileRoute } from "@tanstack/react-router";
import { serveDraftFile } from "~/lib/drafts";
import { getIdentity } from "~/lib/nap-server";
import { route } from "~/server/route";

export const Route = createFileRoute("/api/drafts/$id/preview/$")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        route(serveDraftFile(getIdentity(request), params.id, params._splat ?? "")),
    },
  },
});
