import { Effect } from "effect";
import type { Identity } from "~/lib/nap-server";
import { Database } from "~/server/database";

export type Person = { email: string; name: string | null };

/**
 * The caller, and known Nap users in the caller's email domain, for share suggestions.
 * A profile exists for everyone who has signed in to Nap.
 */
export const listPeople = Effect.fn("listPeople")(function* (identity: Identity) {
  const db = yield* Database;
  const email = identity.email.toLowerCase();
  const domainSuffix = email.slice(email.lastIndexOf("@"));
  const [me, people] = yield* Effect.all(
    [
      db.first<Person>(
        `SELECT lower(email) AS email, display_name AS name FROM profiles WHERE lower(email) = ?`,
        email,
      ),
      db.all<Person>(
        `SELECT lower(email) AS email, display_name AS name
         FROM profiles
         WHERE substr(lower(email), -length(?1)) = ?1 AND lower(email) != ?2
         ORDER BY coalesce(display_name, email) COLLATE NOCASE
         LIMIT 2000`,
        domainSuffix,
        email,
      ),
    ],
    { concurrency: "unbounded" },
  );
  return { me: me ?? { email, name: identity.name }, people };
});
