import { createFileRoute } from "@tanstack/react-router";
import { serveDraftFile } from "~/lib/drafts";
import { getEnv } from "~/lib/nap-server";

export const Route = createFileRoute("/api/drafts/$id/preview/$")({
  server: {
    handlers: {
      GET: async ({ params }) => serveDraftFile(getEnv(), params.id, params._splat ?? ""),
    },
  },
});
