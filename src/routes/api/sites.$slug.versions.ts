import { createFileRoute } from "@tanstack/react-router";
import { ensureProfile, getEnv, getIdentity, json, slugify } from "~/lib/nap-server";
import { canViewSite, getSiteOwner, isCrossSite } from "~/lib/site-access";
import { listVersions, restoreVersion } from "~/lib/versions";

/**
 * GET /api/sites/:slug/versions — the version history, newest first. Anyone who can view it.
 * POST /api/sites/:slug/versions — { version, expectedCurrentVersion? } makes an earlier
 * version live again. Anyone who can view it, not for GitHub-managed sites.
 */
export const Route = createFileRoute("/api/sites/$slug/versions")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);
        const slug = slugify(params.slug);
        const site = slug ? await getSiteOwner(DB, slug) : null;
        if (!site || !(await canViewSite(DB, { ...site, slug }, identity.email))) {
          return json({ error: "Not found" }, { status: 404 });
        }
        return json(
          { versions: await listVersions(DB, slug) },
          { headers: { "cache-control": "no-store" } },
        );
      },
      POST: async ({ params, request }) => {
        if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
        if (!request.headers.get("content-type")?.includes("application/json")) {
          return json({ error: "Expected JSON" }, { status: 415 });
        }
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        return restoreVersion(DB, identity.email, slugify(params.slug), body);
      },
    },
  },
});
