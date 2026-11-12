import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { nextPageUrl, startDirectUpload } from "~/lib/direct-uploads";
import { signedIn, slugify } from "~/lib/nap-server";
import {
  json,
  noStore,
  readJsonObject,
  requireJsonBody,
  requireSameSite,
  stringField,
} from "~/server/http";
import { route } from "~/server/route";

/**
 * POST /api/uploads — starts a direct dashboard upload. JSON:
 * { files: [{ path, size, type }], targetSlug?, expectedCurrentVersion?, kind? }
 * Returns presigned R2 URLs for the first page of files, and `nextPage` while there are more
 * (GET /api/uploads/<id>/urls?offset=<n>). The browser PUTs the files, then POSTs
 * /api/uploads/<id>/commit.
 * 503 with code "direct_uploads_unavailable" means R2 signing is not set up (local
 * development); the dashboard then falls back to /api/upload.
 */
export const Route = createFileRoute("/api/uploads")({
  server: {
    handlers: {
      POST: ({ request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            yield* requireJsonBody(request);
            const identity = yield* signedIn(request);
            const body = yield* readJsonObject(request);
            const started = yield* startDirectUpload(identity, {
              files: body.files,
              targetSlug: slugify(stringField(body.targetSlug)) || null,
              requireExpectedVersion: false,
              expectedCurrentVersion: stringField(body.expectedCurrentVersion) || null,
              kind: stringField(body.kind) === "artifact" ? "artifact" : "site",
              source: "dashboard",
            });
            return json(
              { ...started, nextPage: nextPageUrl("/api", started.uploadId, started.nextOffset) },
              { status: 201, headers: noStore },
            );
          }),
        ),
    },
  },
});
