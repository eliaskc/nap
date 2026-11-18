import { createFileRoute } from "@tanstack/react-router";
import { Effect, Predicate } from "effect";
import { signedIn, slugify } from "~/lib/nap-server";
import { napTypeOf, parseNapType } from "~/lib/nap-types";
import { getSiteOwner, isSameEmail } from "~/lib/site-access";
import { isReservedSlug } from "~/lib/uploads";
import { Database } from "~/server/database";
import { fail, json, readJsonObject, requireSameSite } from "~/server/http";
import { route } from "~/server/route";

/**
 * PATCH /api/sites/:slug/settings — { listed?: boolean, toolbar?: boolean, ownHost?: boolean,
 * type?: "page" | "dashboard" }. Owner only.
 * - listed: show it in the shared, organisation-wide list.
 * - toolbar: show the Nap bar above it. Off, the nap fills the window.
 * - ownHost: serve it on its own host (<name>.<root>) instead of in Nap's frame (<root>/<name>).
 *   The older `kind: "site" | "artifact"` says the same. The nap keeps its name either way, and
 *   the old URL redirects to the new one: the frame sends naps on their own host there, and their
 *   host sends naps in the frame to <root>/<name>.
 * - type: what kind of nap it is (nap-types.ts). Visit counts already stored stay as they are.
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
            if (!site) return yield* fail(404, "Nap not found");
            if (!isSameEmail(site.createdByEmail, identity.email)) {
              return yield* fail(403, "Only the owner can change settings");
            }

            const body = yield* readJsonObject(request);
            const fromOwnHost = Predicate.isBoolean(body.ownHost)
              ? body.ownHost
                ? ("site" as const)
                : ("artifact" as const)
              : null;
            const fromKind = body.kind === "site" || body.kind === "artifact" ? body.kind : null;
            if (fromOwnHost && fromKind && fromOwnHost !== fromKind) {
              return yield* fail(400, "kind and ownHost disagree. Send only ownHost.");
            }
            const kind = fromOwnHost ?? fromKind;
            const type = parseNapType(body.type);
            if (typeof type === "object") return yield* fail(400, type.error);
            const updates: Array<
              [column: "listed" | "toolbar" | "kind" | "type", value: number | string]
            > = [];
            if (Predicate.isBoolean(body.listed)) updates.push(["listed", body.listed ? 1 : 0]);
            if (Predicate.isBoolean(body.toolbar)) updates.push(["toolbar", body.toolbar ? 1 : 0]);
            if (kind) updates.push(["kind", kind]);
            if (type) updates.push(["type", type]);
            if (updates.length === 0) return yield* fail(400, "Nothing to change");

            // In the frame, the name is a path on Nap's own domain, next to Nap's own pages. A nap
            // on its own host may have a name that Nap uses there; it must be renamed first.
            if (kind === "artifact" && site.kind === "site" && isReservedSlug(slug)) {
              return yield* fail(
                409,
                `Nap uses ${slug} for its own pages. Rename the nap before you move it into Nap.`,
              );
            }

            const db = yield* Database;
            const row = yield* db.first<{
              listed: number;
              toolbar: number;
              kind: string;
              type: string;
            }>(
              `UPDATE sites SET ${updates.map(([column]) => `${column} = ?`).join(", ")}
               WHERE slug = ? RETURNING listed, toolbar, kind, type`,
              ...updates.map(([, value]) => value),
              slug,
            );
            if (!row) return yield* fail(404, "Nap not found");

            return json({
              ok: true,
              slug,
              listed: Boolean(row.listed),
              toolbar: Boolean(row.toolbar),
              kind: row.kind,
              ownHost: row.kind === "site",
              type: napTypeOf(row.type),
            });
          }),
        ),
    },
  },
});
