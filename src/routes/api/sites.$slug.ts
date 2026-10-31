import { createFileRoute } from "@tanstack/react-router";
import { ensureProfile, getEnv, getIdentity, json, slugify } from "~/lib/nap-server";
import { isSameEmail } from "~/lib/site-access";
import { rekeyNap } from "~/lib/rekey";
import { isReservedSlug } from "~/lib/uploads";

export const Route = createFileRoute("/api/sites/$slug")({
  server: {
    handlers: {
      PATCH: async ({ params, request }) => {
        const { DB, SITES } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);

        const body = (await request.json()) as { title?: string; slug?: string };
        const currentSlug = slugify(params.slug);
        const nextSlug = slugify(body.slug ?? currentSlug);
        const title = body.title?.trim().slice(0, 120) ?? "";

        if (!currentSlug) return json({ error: "Missing site slug" }, { status: 400 });
        if (!nextSlug) return json({ error: "Missing new slug" }, { status: 400 });
        if (!title) return json({ error: "Missing title" }, { status: 400 });

        const site = await DB.prepare(
          "SELECT created_by_email AS createdByEmail, kind FROM sites WHERE slug = ?",
        )
          .bind(currentSlug)
          .first<{ createdByEmail: string; kind: string }>();

        if (!site) return json({ error: "Site not found" }, { status: 404 });
        if (!isSameEmail(site.createdByEmail, identity.email))
          return json({ error: "Only the owner can rename it" }, { status: 403 });

        // An artifact's id is random, not a name. Move it to Sites to choose a URL.
        if (nextSlug !== currentSlug && site.kind === "artifact")
          return json({ error: "An artifact's URL cannot be changed" }, { status: 400 });

        if (nextSlug !== currentSlug && isReservedSlug(nextSlug))
          return json({ error: "That URL is reserved" }, { status: 409 });

        if (nextSlug !== currentSlug) {
          const taken = await DB.prepare("SELECT slug FROM sites WHERE slug = ?")
            .bind(nextSlug)
            .first<{ slug: string }>();
          if (taken) return json({ error: "Slug is already taken" }, { status: 409 });

          await rekeyNap({ DB, SITES }, currentSlug, nextSlug, { email: identity.email, title });
        } else {
          const updated = await DB.prepare(
            `UPDATE sites
             SET title = ?, updated_by_email = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE slug = ? AND management_type = 'direct'`,
          )
            .bind(title, identity.email, currentSlug)
            .run();

          if (!updated.success || updated.meta.changes === 0) {
            return json({ error: "Site not found" }, { status: 404 });
          }
        }

        return json({ ok: true, site: { slug: nextSlug, title } });
      },
      DELETE: async ({ params, request }) => {
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);

        const slug = slugify(params.slug);
        if (!slug) return json({ error: "Missing site slug" }, { status: 400 });

        const site = await DB.prepare(
          "SELECT created_by_email AS createdByEmail FROM sites WHERE slug = ?",
        )
          .bind(slug)
          .first<{ createdByEmail: string }>();
        if (!site) return json({ error: "Site not found" }, { status: 404 });
        if (!isSameEmail(site.createdByEmail, identity.email))
          return json({ error: "Only the owner can delete it" }, { status: 403 });

        // One transaction. A source repo stays in Artifacts, like the version files in R2.
        const results = await DB.batch([
          DB.prepare("DELETE FROM site_documents WHERE site_slug = ?").bind(slug),
          DB.prepare("DELETE FROM comments WHERE site_slug = ?").bind(slug),
          DB.prepare("DELETE FROM versions WHERE site_slug = ?").bind(slug),
          DB.prepare("DELETE FROM sites WHERE slug = ?").bind(slug),
          DB.prepare("DELETE FROM nap_redirects WHERE site_slug = ?").bind(slug),
        ]);
        const deleted = results[3];

        if (!deleted.success || deleted.meta.changes === 0) {
          return json({ error: "Site not found" }, { status: 404 });
        }

        return json({ ok: true });
      },
    },
  },
});
