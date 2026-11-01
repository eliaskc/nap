import { createFileRoute } from "@tanstack/react-router";
import { serveDraftFile } from "~/lib/drafts";
import { route } from "~/server/route";

export const Route = createFileRoute("/api/drafts/$id/preview/$")({
  server: {
    handlers: {
      GET: ({ params }) => route(serveDraftFile(params.id, params._splat ?? "")),
    },
  },
});
