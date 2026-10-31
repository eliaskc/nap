import { createFileRoute } from "@tanstack/react-router";
import { ensureProfile, getEnv, getIdentity, json, slugify } from "~/lib/nap-server";
import { rekeyNap } from "~/lib/rekey";
import { getSiteOwner, isCrossSite, isSameEmail } from "~/lib/site-access";
import { pickArtifactId } from "~/lib/uploads";

/**
 * PATCH /api/sites/:slug/settings — { listed?: boolean, toolbar?: boolean, kind?: "site" | "artifact" }.
 * Owner only. listed: show a site in the shared, organisation-wide list. toolbar: frame it under the
 * Nap bar (sites only; artifacts always have it). kind: move it between Sites (<slug>.<root>) and
 * Artifacts (<root>/artifact/<id>). A site that becomes an artifact gets a random id; its slug
 * stays only as a redirect. An artifact that becomes a site keeps its id as its host until the
 * owner renames it. The old URL redirects to the new one.
 */
export const Route = createFileRoute("/api/sites/$slug/settings")({
  server: {
    handlers: {
      PATCH: async ({ params, request }) => {
        if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
        const { DB, SITES } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);

        const slug = slugify(params.slug);
        const site = slug ? await getSiteOwner(DB, slug) : null;
        if (!site) return json({ error: "Site not found" }, { status: 404 });
        if (!isSameEmail(site.createdByEmail, identity.email)) {
          return json({ error: "Only the owner can change settings" }, { status: 403 });
        }

        const body = (await request.json().catch(() => ({}))) as {
          listed?: unknown;
          toolbar?: unknown;
          kind?: unknown;
        };
        const updates: Array<[column: "listed" | "toolbar" | "kind", value: number | string]> = [];
        if (typeof body.listed === "boolean") updates.push(["listed", body.listed ? 1 : 0]);
        if (typeof body.toolbar === "boolean") updates.push(["toolbar", body.toolbar ? 1 : 0]);
        if (body.kind === "site" || body.kind === "artifact") updates.push(["kind", body.kind]);
        if (updates.length === 0) return json({ error: "Nothing to change" }, { status: 400 });

        // An artifact's key is a random id, never a name. Give the site one and keep its slug as a
        // redirect, so <slug>.<root> and old links still work.
        let key = slug;
        if (body.kind === "artifact" && site.kind === "site") {
          if (site.sourceRepo) {
            return json(
              { error: "A site with a source repo cannot become an artifact" },
              { status: 409 },
            );
          }
          key = await pickArtifactId(async (id) =>
            Boolean(await DB.prepare("SELECT 1 FROM sites WHERE slug = ?").bind(id).first()),
          );
          await rekeyNap({ DB, SITES }, slug, key, {
            email: identity.email,
            kind: "artifact",
            redirect: true,
          });
        }

        const row = await DB.prepare(
          `UPDATE sites SET ${updates.map(([column]) => `${column} = ?`).join(", ")}
           WHERE slug = ? RETURNING listed, toolbar, kind`,
        )
          .bind(...updates.map(([, value]) => value), key)
          .first<{ listed: number; toolbar: number; kind: string }>();
        if (!row) return json({ error: "Site not found" }, { status: 404 });

        return json({
          ok: true,
          slug: key,
          listed: Boolean(row.listed),
          toolbar: Boolean(row.toolbar),
          kind: row.kind,
        });
      },
    },
  },
});
