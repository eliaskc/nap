import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { signedIn, slugify } from "~/lib/nap-server";
import { rekeyNap } from "~/lib/rekey";
import { isSameEmail } from "~/lib/site-access";
import { deleteSiteFiles } from "~/lib/site-files";
import { isReservedSlug } from "~/lib/uploads";
import { Database, sql } from "~/server/database";
import { fail, json } from "~/server/http";
import { inBackground } from "~/server/platform";
import { route } from "~/server/route";

export const Route = createFileRoute("/api/sites/$slug")({
  server: {
    handlers: {
      PATCH: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const body = (yield* Effect.promise(() => request.json())) as {
              title?: string;
              slug?: string;
            };
            const currentSlug = slugify(params.slug);
            const nextSlug = slugify(body.slug ?? currentSlug);
            const title = body.title?.trim().slice(0, 120) ?? "";

            if (!currentSlug) return yield* fail(400, "Missing site slug");
            if (!nextSlug) return yield* fail(400, "Missing new slug");
            if (!title) return yield* fail(400, "Missing title");

            const db = yield* Database;
            const site = yield* db.first<{ createdByEmail: string; kind: string }>(
              "SELECT created_by_email AS createdByEmail, kind FROM sites WHERE slug = ?",
              currentSlug,
            );

            if (!site) return yield* fail(404, "Site not found");
            if (!isSameEmail(site.createdByEmail, identity.email))
              return yield* fail(403, "Only the owner can rename it");

            // An artifact's id is random, not a name. Move it to Sites to choose a URL.
            if (nextSlug !== currentSlug && site.kind === "artifact")
              return yield* fail(400, "An artifact's URL cannot be changed");

            if (nextSlug !== currentSlug && isReservedSlug(nextSlug))
              return yield* fail(409, "That URL is reserved");

            if (nextSlug !== currentSlug) {
              const taken = yield* db.first("SELECT slug FROM sites WHERE slug = ?", nextSlug);
              if (taken) return yield* fail(409, "Slug is already taken");

              yield* rekeyNap(currentSlug, nextSlug, { email: identity.email, title });
            } else {
              const updated = yield* db.run(
                `UPDATE sites
                 SET title = ?, updated_by_email = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE slug = ? AND management_type = 'direct'`,
                title,
                identity.email,
                currentSlug,
              );
              if (updated.changes === 0) return yield* fail(404, "Site not found");
            }

            return json({ ok: true, site: { slug: nextSlug, title } });
          }),
        ),
      DELETE: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const slug = slugify(params.slug);
            if (!slug) return yield* fail(400, "Missing site slug");

            const db = yield* Database;
            const site = yield* db.first<{ createdByEmail: string }>(
              "SELECT created_by_email AS createdByEmail FROM sites WHERE slug = ?",
              slug,
            );
            if (!site) return yield* fail(404, "Site not found");
            if (!isSameEmail(site.createdByEmail, identity.email))
              return yield* fail(403, "Only the owner can delete it");

            // One transaction. A source repo stays in Artifacts, like the version files in R2.
            const results = yield* db.batch([
              sql("DELETE FROM site_documents WHERE site_slug = ?", slug),
              sql("DELETE FROM comments WHERE site_slug = ?", slug),
              sql("DELETE FROM versions WHERE site_slug = ?", slug),
              sql("DELETE FROM sites WHERE slug = ?", slug),
              sql("DELETE FROM nap_redirects WHERE site_slug = ?", slug),
            ]);
            if (results[3].changes === 0) return yield* fail(404, "Site not found");
            // Its files (nap.files) go with it; the version files stay, as they always have.
            yield* inBackground(deleteSiteFiles(slug), "Deleting a site's files failed");

            return json({ ok: true });
          }),
        ),
    },
  },
});
