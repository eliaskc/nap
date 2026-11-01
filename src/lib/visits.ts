import { Effect } from "effect";
import { Database } from "~/server/database";
import { inBackground } from "~/server/platform";

/**
 * Remembers that this person opened this site or artifact, after the response. The dashboard
 * uses it to list other people's artifacts the person has seen, and to sort by recent visits.
 */
export const recordVisit = Effect.fn("recordVisit")(function* (email: string, slug: string) {
  const db = yield* Database;
  yield* inBackground(
    db
      .run(
        `INSERT INTO site_visits (email, site_slug) VALUES (lower(?), ?)
         ON CONFLICT (email, site_slug)
         DO UPDATE SET visited_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        email,
        slug,
      )
      .pipe(Effect.asVoid),
    "Recording a visit failed",
  );
});
