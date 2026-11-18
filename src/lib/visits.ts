import { Effect } from "effect";
import { listPeople, nameFromEmail } from "~/lib/profiles";
import type { Color, Shape } from "~/lib/looks";
import { Database } from "~/server/database";
import { inBackground } from "~/server/platform";

/*
 * Nap keeps three numbers per nap:
 * - people: everyone but the owner who has opened it (rows in site_visits);
 * - views: the sum of their visits (site_visits.visit_count; opens within 30 minutes count once,
 *   a dashboard once per person). Most popular ranks by this, and items show it;
 * - loads: every load of its page by anyone, the owner too, with no 30-minute or dashboard rule
 *   (sites.view_count and sites.last_viewed_at). It shows how heavily a nap is used, pages that
 *   reload themselves included. Only the owner sees it, in Visitors.
 */

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
/** Opens closer together than this are one visit, so reloads and clicking around count once. */
const SAME_VISIT = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')`;

/**
 * Remembers that this person opened this site or artifact, after the response. The dashboard
 * uses it to list other people's artifacts the person has seen, to sort by recent visits, to
 * count the people who have opened each one, and to show owners who they are.
 *
 * A dashboard (type "dashboard") is opened again and again, and often left open on a screen
 * that reloads it, so repeat opens are not counted: its visit_count stays at 1 per person, while
 * visited_at still moves. The rule follows the type at the time of the visit; counts already
 * stored stay when the owner changes the type.
 */
export const recordVisit = Effect.fn("recordVisit")(function* (
  email: string,
  nap: { slug: string; type: string },
) {
  const db = yield* Database;
  const countsRepeats = nap.type === "dashboard" ? 0 : 1;
  yield* inBackground(
    db
      .run(
        `INSERT INTO site_visits (email, site_slug, first_visited_at) VALUES (lower(?), ?, ${NOW})
         ON CONFLICT (email, site_slug) DO UPDATE SET
           visit_count = visit_count + (? AND visited_at < ${SAME_VISIT}),
           visited_at = ${NOW}`,
        email,
        nap.slug,
        countsRepeats,
      )
      .pipe(Effect.asVoid),
    "Recording a visit failed",
  );
});

/**
 * Counts one load of a nap's page in sites.view_count, after the response, so it never slows or
 * fails the page. Called for each live index.html a person's browser gets (getNapFile), in the
 * frame and on a nap's own host; not for other files, earlier versions, or Nap's own routes.
 */
export const recordLoad = Effect.fn("recordLoad")(function* (slug: string) {
  const db = yield* Database;
  yield* inBackground(
    db
      .run(
        `UPDATE sites SET view_count = view_count + 1, last_viewed_at = ${NOW} WHERE slug = ?`,
        slug,
      )
      .pipe(Effect.asVoid),
    "Counting a load failed",
  );
});

/** Every load of its page, the owner's too (sites.view_count). Only for the owner. */
export const countLoads = Effect.fn("countLoads")(function* (slug: string) {
  const db = yield* Database;
  const row = yield* db.first<{ loads: number; lastLoadedAt: string | null }>(
    "SELECT view_count AS loads, last_viewed_at AS lastLoadedAt FROM sites WHERE slug = ?",
    slug,
  );
  return { loads: row?.loads ?? 0, lastLoadedAt: row?.lastLoadedAt ?? null };
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
