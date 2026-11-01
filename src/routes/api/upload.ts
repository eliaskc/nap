import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { signedIn, slugify } from "~/lib/nap-server";
import { publishFiles } from "~/lib/publish";
import { normalizePath } from "~/lib/uploads";
import { json, requireSameSite } from "~/server/http";
import { route } from "~/server/route";

/**
 * POST /api/upload — dashboard uploads.
 * - With targetSlug: a new version of a nap the person can view. It keeps the title unless the
 *   owner sends one.
 * - Without: a new private, unlisted site at a random URL (or at `slug`, for scripts). The title comes from the form, the
 *   page's <title>, or "Untitled site". The owner can rename it later.
 */

export const Route = createFileRoute("/api/upload")({
  server: {
    handlers: {
      POST: ({ request }) =>
        route(
          Effect.gen(function* () {
            // A multipart form needs no preflight, so check the origin here.
            yield* requireSameSite(request);
            const identity = yield* signedIn(request);

            const form = yield* Effect.promise(() => request.formData());
            const files = form
              .getAll("files")
              .filter((value): value is File => value instanceof File)
              .map((file) => ({ path: normalizePath(file.name), body: file }));

            const { slug, kind, title, currentVersion } = yield* publishFiles(identity, {
              files,
              targetSlug: slugify(String(form.get("targetSlug") ?? "")) || null,
              expectedCurrentVersion: String(form.get("expectedCurrentVersion") ?? "") || null,
              kind: form.get("kind") === "artifact" ? "artifact" : "site",
              slug: slugify(String(form.get("slug") ?? "")),
              title: String(form.get("title") ?? ""),
              source: "dashboard",
            });
            return json({ ok: true, site: { slug, kind, title, currentVersion } });
          }),
        ),
    },
  },
});
