import { createFileRoute } from "@tanstack/react-router";
import { ensureProfile, getEnv, getIdentity, json, slugify } from "~/lib/nap-server";
import { publishFiles } from "~/lib/publish";
import { isCrossSite } from "~/lib/site-access";
import { normalizePath } from "~/lib/uploads";

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
      POST: async ({ request }) => {
        // A multipart form needs no preflight, so check the origin here.
        if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
        const env = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(env.DB, identity);

        const form = await request.formData();
        const files = form
          .getAll("files")
          .filter((value): value is File => value instanceof File)
          .map((file) => ({ path: normalizePath(file.name), body: file }));

        const published = await publishFiles(env, identity, {
          files,
          targetSlug: slugify(String(form.get("targetSlug") ?? "")) || null,
          expectedCurrentVersion: String(form.get("expectedCurrentVersion") ?? "") || null,
          kind: form.get("kind") === "artifact" ? "artifact" : "site",
          slug: slugify(String(form.get("slug") ?? "")),
          title: String(form.get("title") ?? ""),
          source: "dashboard",
        });
        if (published instanceof Response) return published;

        const { slug, kind, title, currentVersion } = published;
        return json({ ok: true, site: { slug, kind, title, currentVersion } });
      },
    },
  },
});
