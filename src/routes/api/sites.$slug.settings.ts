import { createFileRoute } from "@tanstack/react-router";
import { Effect, Predicate } from "effect";
import { signedIn, slugify } from "~/lib/nap-server";
import { rekeyNap } from "~/lib/rekey";
import { getSiteOwner, isSameEmail } from "~/lib/site-access";
import { pickArtifactId } from "~/lib/uploads";
import { Database } from "~/server/database";
import { fail, json, readJsonObject, requireSameSite } from "~/server/http";
import { route } from "~/server/route";

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
      PATCH: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            const identity = yield* signedIn(request);

            const slug = slugify(params.slug);
            const site = slug ? yield* getSiteOwner(slug) : null;
            if (!site) return yield* fail(404, "Site not found");
            if (!isSameEmail(site.createdByEmail, identity.email)) {
              return yield* fail(403, "Only the owner can change settings");
            }

            const body = yield* readJsonObject(request);
            const updates: Array<[column: "listed" | "toolbar" | "kind", value: number | string]> =
              [];
            if (Predicate.isBoolean(body.listed)) updates.push(["listed", body.listed ? 1 : 0]);
            if (Predicate.isBoolean(body.toolbar)) updates.push(["toolbar", body.toolbar ? 1 : 0]);
            if (body.kind === "site" || body.kind === "artifact") updates.push(["kind", body.kind]);
            if (updates.length === 0) return yield* fail(400, "Nothing to change");

            // An artifact's key is a random id, never a name. Give the site one and keep its slug
            // as a redirect, so <slug>.<root> and old links still work.
            const db = yield* Database;
            let key = slug;
            if (body.kind === "artifact" && site.kind === "site") {
              if (site.sourceRepo) {
                return yield* fail(409, "A site with a source repo cannot become an artifact");
              }
              key = yield* pickArtifactId((id) =>
                db.first("SELECT 1 FROM sites WHERE slug = ?", id).pipe(Effect.map(Boolean)),
              );
              yield* rekeyNap(slug, key, {
                email: identity.email,
                kind: "artifact",
                redirect: true,
              });
            }

            const row = yield* db.first<{ listed: number; toolbar: number; kind: string }>(
              `UPDATE sites SET ${updates.map(([column]) => `${column} = ?`).join(", ")}
               WHERE slug = ? RETURNING listed, toolbar, kind`,
              ...updates.map(([, value]) => value),
              key,
            );
            if (!row) return yield* fail(404, "Site not found");

            return json({
              ok: true,
              slug: key,
              listed: Boolean(row.listed),
              toolbar: Boolean(row.toolbar),
              kind: row.kind,
            });
          }),
        ),
    },
  },
});
