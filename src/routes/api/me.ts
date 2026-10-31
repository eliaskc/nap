import { createFileRoute } from "@tanstack/react-router";
import { getEnv, getIdentity, json, ensureProfile } from "~/lib/nap-server";

export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);

        const profile = await DB.prepare(
          `SELECT email, display_name AS displayName, username, avatar_color AS avatarColor
           FROM profiles WHERE email = ?`,
        )
          .bind(identity.email)
          .first();

        return json({ profile });
      },
      PATCH: async ({ request }) => {
        const { DB } = getEnv();
        const identity = getIdentity(request);
        await ensureProfile(DB, identity);
        const body = (await request.json()) as { displayName?: string; username?: string };
        const displayName = body.displayName?.trim().slice(0, 80) || identity.name;
        const username =
          body.username
            ?.trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, "")
            .slice(0, 32) || null;

        await DB.prepare(
          `UPDATE profiles
           SET display_name = ?, username = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE email = ?`,
        )
          .bind(displayName, username, identity.email)
          .run();

        return json({ ok: true });
      },
    },
  },
});
