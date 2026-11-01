import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { signedIn } from "~/lib/nap-server";
import { findPerson } from "~/lib/profiles";
import { Database } from "~/server/database";
import { json } from "~/server/http";
import { route } from "~/server/route";

export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: ({ request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const db = yield* Database;
            const profile = yield* db.first(
              `SELECT email, display_name AS displayName, username, avatar_color AS avatarColor
               FROM profiles WHERE email = ?`,
              identity.email,
            );
            const person = yield* findPerson(identity.email);
            return json({
              profile: profile && { ...profile, shape: person.shape, color: person.color },
            });
          }),
        ),
      PATCH: ({ request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const body = (yield* Effect.promise(() => request.json())) as {
              displayName?: string;
              username?: string;
            };
            const displayName = body.displayName?.trim().slice(0, 80) || identity.name;
            const username =
              body.username
                ?.trim()
                .toLowerCase()
                .replace(/[^a-z0-9_-]/g, "")
                .slice(0, 32) || null;

            const db = yield* Database;
            yield* db.run(
              `UPDATE profiles
               SET display_name = ?, username = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               WHERE email = ?`,
              displayName,
              username,
              identity.email,
            );
            return json({ ok: true });
          }),
        ),
    },
  },
});
