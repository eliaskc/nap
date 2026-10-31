import type { Identity } from "~/lib/nap-server";

export type Person = { email: string; name: string | null };

/**
 * The caller, and known Nap users in the caller's email domain, for share suggestions.
 * A profile exists for everyone who has signed in to Nap.
 */
export async function listPeople(db: D1Database, identity: Identity) {
  const email = identity.email.toLowerCase();
  const domainSuffix = email.slice(email.lastIndexOf("@"));
  const [me, people] = await Promise.all([
    db
      .prepare(
        `SELECT lower(email) AS email, display_name AS name FROM profiles WHERE lower(email) = ?`,
      )
      .bind(email)
      .first<Person>(),
    db
      .prepare(
        `SELECT lower(email) AS email, display_name AS name
         FROM profiles
         WHERE substr(lower(email), -length(?1)) = ?1 AND lower(email) != ?2
         ORDER BY coalesce(display_name, email) COLLATE NOCASE
         LIMIT 2000`,
      )
      .bind(domainSuffix, email)
      .all<Person>(),
  ]);
  return { me: me ?? { email, name: identity.name }, people: people.results };
}
