import { createFileRoute } from "@tanstack/react-router";
import { startDirectUpload } from "~/lib/direct-uploads";
import { ensureProfile, getEnv, getIdentity, json, slugify } from "~/lib/nap-server";
import { isCrossSite } from "~/lib/site-access";

/**
 * POST /api/uploads — starts a direct dashboard upload. JSON:
 * { files: [{ path, size, type }], targetSlug?, expectedCurrentVersion?, kind? }
 * Returns presigned R2 URLs. The browser PUTs the files, then POSTs /api/uploads/<id>/commit.
 * 503 with code "direct_uploads_unavailable" means R2 signing is not set up (local
 * development); the dashboard then falls back to /api/upload.
 */
export const Route = createFileRoute("/api/uploads")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
        if (!request.headers.get("content-type")?.includes("application/json")) {
          return json({ error: "Expected JSON" }, { status: 415 });
        }
        const env = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(env.DB, identity);
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const text = (name: string) =>
          typeof body[name] === "string" ? (body[name] as string) : "";
        return startDirectUpload(env, identity, {
          files: body.files,
          targetSlug: slugify(text("targetSlug")) || null,
          requireExpectedVersion: false,
          expectedCurrentVersion: text("expectedCurrentVersion") || null,
          kind: text("kind") === "artifact" ? "artifact" : "site",
          source: "dashboard",
        });
      },
    },
  },
});
