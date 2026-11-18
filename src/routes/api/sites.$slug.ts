import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { signedIn, slugify } from "~/lib/nap-server";
import { rekeyNap } from "~/lib/rekey";
import { isSameEmail } from "~/lib/site-access";
import { deleteSiteFiles } from "~/lib/site-files";
import { isReservedSlug, pickArtifactId } from "~/lib/uploads";
import { Database, sql } from "~/server/database";
import { fail, json } from "~/server/http";
import { inBackground } from "~/server/platform";
import { route } from "~/server/route";

export const Route = createFileRoute("/api/sites/$slug")({
  server: {
    handlers: {
      /**
       * PATCH /api/sites/:slug — { title, slug?, randomName? }. Owner only. Renames a nap: its
       * title, and its name (the path in <root>/<name>, or the host of a nap on its own host).
       * randomName: true gives it a new random id instead of a chosen name. The old name stays
       * as a redirect (nap_redirects), so old links keep working.
       */
      PATCH: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const body = (yield* Effect.promise(() => request.json())) as {
              title?: string;
              slug?: string;
              randomName?: boolean;
            };
            const currentSlug = slugify(params.slug);
            const title = body.title?.trim().slice(0, 120) ?? "";

            if (!currentSlug) return yield* fail(400, "Missing name");
            if (!title) return yield* fail(400, "Missing title");

            const db = yield* Database;
            const isTaken = (slug: string) =>
              db.first("SELECT 1 FROM sites WHERE slug = ?", slug).pipe(Effect.map(Boolean));
            const nextSlug =
              body.randomName === true
                ? yield* pickArtifactId(isTaken)
                : slugify(body.slug ?? currentSlug);
            if (!nextSlug) return yield* fail(400, "Missing new name");

            const site = yield* db.first<{ createdByEmail: string; kind: string }>(
              "SELECT created_by_email AS createdByEmail, kind FROM sites WHERE slug = ?",
              currentSlug,
            );

            if (!site) return yield* fail(404, "Nap not found");
            if (!isSameEmail(site.createdByEmail, identity.email))
              return yield* fail(403, "Only the owner can rename it");

            if (nextSlug !== currentSlug && isReservedSlug(nextSlug))
              return yield* fail(409, "That name is reserved");

            if (nextSlug !== currentSlug) {
              if (yield* isTaken(nextSlug)) return yield* fail(409, "That name is already taken");

              yield* rekeyNap(currentSlug, nextSlug, {
                email: identity.email,
                title,
                redirect: true,
              });
            } else {
              const updated = yield* db.run(
                `UPDATE sites
                 SET title = ?, updated_by_email = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE slug = ? AND management_type = 'direct'`,
                title,
                identity.email,
                currentSlug,
              );
              if (updated.changes === 0) return yield* fail(404, "Nap not found");
            }

            return json({ ok: true, site: { slug: nextSlug, title } });
          }),
        ),
      DELETE: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const slug = slugify(params.slug);
            if (!slug) return yield* fail(400, "Missing name");

            const db = yield* Database;
            const site = yield* db.first<{ createdByEmail: string }>(
              "SELECT created_by_email AS createdByEmail FROM sites WHERE slug = ?",
              slug,
            );
            if (!site) return yield* fail(404, "Nap not found");
            if (!isSameEmail(site.createdByEmail, identity.email))
              return yield* fail(403, "Only the owner can delete it");

            // One transaction. A source repo stays in Cloudflare Artifacts, like the version files in R2.
            const results = yield* db.batch([
              sql("DELETE FROM site_documents WHERE site_slug = ?", slug),
              sql("DELETE FROM comments WHERE site_slug = ?", slug),
              sql("DELETE FROM access_requests WHERE site_slug = ?", slug),
              sql("DELETE FROM versions WHERE site_slug = ?", slug),
              sql("DELETE FROM sites WHERE slug = ?", slug),
              sql("DELETE FROM nap_redirects WHERE site_slug = ?", slug),
            ]);
            if (results[4].changes === 0) return yield* fail(404, "Nap not found");
            // Its files (nap.files) go with it; the version files stay, as they always have.
            yield* inBackground(deleteSiteFiles(slug), "Deleting a nap's files failed");

            return json({ ok: true });
          }),
        ),
    },
  },
});
