import { Effect } from "effect";
import { listPeople, nameFromEmail } from "~/lib/profiles";
import type { Color, Shape } from "~/lib/looks";
import { Database } from "~/server/database";
import { inBackground } from "~/server/platform";

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
/** Opens closer together than this are one visit, so reloads and clicking around count once. */
const SAME_VISIT = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')`;

/**
 * Remembers that this person opened this site or artifact, after the response. The dashboard
 * uses it to list other people's artifacts the person has seen, to sort by recent visits, to
 * count the people who have opened each one, and to show owners who they are.
 */
export const recordVisit = Effect.fn("recordVisit")(function* (email: string, slug: string) {
  const db = yield* Database;
  yield* inBackground(
    db
      .run(
        `INSERT INTO site_visits (email, site_slug, first_visited_at) VALUES (lower(?), ?, ${NOW})
         ON CONFLICT (email, site_slug) DO UPDATE SET
           visit_count = visit_count + (visited_at < ${SAME_VISIT}),
           visited_at = ${NOW}`,
        email,
        slug,
      )
      .pipe(Effect.asVoid),
    "Recording a visit failed",
  );
});

export type Visitor = {
  email: string;
  name: string;
  shape: Shape | null;
  color: Color | null;
  firstVisitedAt: string;
  visitedAt: string;
  visits: number;
};

/** Everyone but the owner who has opened it, most recent first. Only for the owner. */
export const listVisitors = Effect.fn("listVisitors")(function* (slug: string, ownerEmail: string) {
  const db = yield* Database;
  const rows = yield* db.all<{
    email: string;
    firstVisitedAt: string | null;
    visitedAt: string;
    visits: number;
  }>(
    `SELECT email, first_visited_at AS firstVisitedAt, visited_at AS visitedAt,
            visit_count AS visits
     FROM site_visits
     WHERE site_slug = ? AND email <> lower(?)
     ORDER BY visited_at DESC`,
    slug,
    ownerEmail,
  );
  if (rows.length === 0) return [];
  const people = new Map(
    (yield* listPeople(rows.map((row) => row.email))).map((person) => [person.email, person]),
  );
  return rows.map((row): Visitor => {
    const person = people.get(row.email);
    return {
      email: row.email,
      name: person?.name ?? nameFromEmail(row.email),
      shape: person?.shape ?? null,
      color: person?.color ?? null,
      firstVisitedAt: row.firstVisitedAt ?? row.visitedAt,
      visitedAt: row.visitedAt,
      visits: row.visits,
    };
  });
});
