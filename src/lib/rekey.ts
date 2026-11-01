import { Effect } from "effect";
import type { SiteKind } from "~/lib/uploads";
import { Database, sql } from "~/server/database";
import { objectHeaders, Storage } from "~/server/storage";

type NapRow = {
  slug: string;
  title: string;
  createdByEmail: string;
  currentVersion: string;
  sortOrder: number;
  themeJson: string;
  createdAt: string;
  viewCount: number;
  lastViewedAt: string | null;
  visibility: string;
  listed: number;
  toolbar: number;
  kind: SiteKind;
  sourceRepo: string | null;
};

/**
 * Gives a nap a new key (its slug or artifact id). The key is in the R2 paths and in every table
 * that points at the nap, so this copies the files and moves the rows. The caller checks that the
 * person may do it and that the new key is free. A source repo keeps its name.
 *
 * - title, kind: change these too, in the same step.
 * - redirect: keep the old key in nap_redirects, so old links go to the new URL.
 */
export const rekeyNap = Effect.fn("rekeyNap")(function* (
  from: string,
  to: string,
  options: { email: string; title?: string; kind?: SiteKind; redirect?: boolean },
) {
  const db = yield* Database;
  const nap = yield* db.first<NapRow>(
    `SELECT slug, title, created_by_email AS createdByEmail, current_version AS currentVersion,
            sort_order AS sortOrder, theme_json AS themeJson, created_at AS createdAt,
            view_count AS viewCount, last_viewed_at AS lastViewedAt, visibility, listed, toolbar,
            kind, source_repo AS sourceRepo
     FROM sites WHERE slug = ? AND management_type = 'direct'`,
    from,
  );
  if (!nap) return false;

  yield* copySiteObjects(from, to);
  const move = (table: string) =>
    sql(`UPDATE ${table} SET site_slug = ? WHERE site_slug = ?`, to, from);
  yield* db.batch([
    sql(
      `INSERT INTO sites (
         slug, title, created_by_email, updated_by_email, current_version, sort_order,
         theme_json, created_at, updated_at, view_count, last_viewed_at, visibility,
         listed, toolbar, kind, source_repo
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?, ?, ?, ?, ?)`,
      to,
      options.title ?? nap.title,
      nap.createdByEmail,
      options.email,
      nap.currentVersion,
      nap.sortOrder,
      nap.themeJson,
      nap.createdAt,
      nap.viewCount,
      nap.lastViewedAt,
      nap.visibility,
      nap.listed,
      nap.toolbar,
      options.kind ?? nap.kind,
      nap.sourceRepo,
    ),
    move("versions"),
    move("site_viewers"),
    move("site_documents"),
    move("comments"),
    move("artifact_frames"),
    move("site_visits"),
    // Keep agent `replaces=<claim id>` updates pointing at the nap.
    move("drafts"),
    // Older redirects follow the nap to its new key.
    move("nap_redirects"),
    sql("DELETE FROM nap_redirects WHERE slug = ?", to),
    ...(options.redirect
      ? [
          sql(
            `INSERT INTO nap_redirects (slug, site_slug) VALUES (?, ?)
             ON CONFLICT (slug) DO UPDATE SET site_slug = excluded.site_slug`,
            from,
            to,
          ),
        ]
      : []),
    sql("DELETE FROM sites WHERE slug = ?", from),
  ]);
  return true;
});

/** The current key of a nap that had this key before, if any. */
export const findRedirect = Effect.fn("findRedirect")(function* (slug: string) {
  const db = yield* Database;
  const row = yield* db.first<{ slug: string }>(
    `SELECT nap_redirects.site_slug AS slug FROM nap_redirects
     JOIN sites ON sites.slug = nap_redirects.site_slug
     WHERE nap_redirects.slug = ?`,
    slug,
  );
  return row?.slug ?? null;
});

const copySiteObjects = Effect.fnUntraced(function* (fromSlug: string, toSlug: string) {
  const storage = yield* Storage;
  const fromPrefix = `sites/${fromSlug}/`;
  const toPrefix = `sites/${toSlug}/`;
  for (const item of yield* storage.list(fromPrefix)) {
    const source = yield* storage.get(item.key);
    if (!source) continue;
    yield* storage.put(item.key.replace(fromPrefix, toPrefix), source.body, {
      httpMetadata: Object.fromEntries(objectHeaders(source)),
      customMetadata: source.customMetadata,
    });
  }
});
