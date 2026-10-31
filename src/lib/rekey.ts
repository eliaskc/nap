import type { SiteKind } from "~/lib/uploads";

type RekeyEnv = { DB: D1Database; SITES: R2Bucket };

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
export async function rekeyNap(
  env: RekeyEnv,
  from: string,
  to: string,
  options: { email: string; title?: string; kind?: SiteKind; redirect?: boolean },
) {
  const { DB } = env;
  const nap = await DB.prepare(
    `SELECT slug, title, created_by_email AS createdByEmail, current_version AS currentVersion,
            sort_order AS sortOrder, theme_json AS themeJson, created_at AS createdAt,
            view_count AS viewCount, last_viewed_at AS lastViewedAt, visibility, listed, toolbar,
            kind, source_repo AS sourceRepo
     FROM sites WHERE slug = ? AND management_type = 'direct'`,
  )
    .bind(from)
    .first<NapRow>();
  if (!nap) return false;

  await copySiteObjects(env.SITES, from, to);
  const move = (table: string) =>
    DB.prepare(`UPDATE ${table} SET site_slug = ? WHERE site_slug = ?`).bind(to, from);
  await DB.batch([
    DB.prepare(
      `INSERT INTO sites (
         slug, title, created_by_email, updated_by_email, current_version, sort_order,
         theme_json, created_at, updated_at, view_count, last_viewed_at, visibility,
         listed, toolbar, kind, source_repo
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
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
    // Keep agent `replaces=<claim id>` updates pointing at the nap.
    move("drafts"),
    // Older redirects follow the nap to its new key.
    move("nap_redirects"),
    DB.prepare("DELETE FROM nap_redirects WHERE slug = ?").bind(to),
    ...(options.redirect
      ? [
          DB.prepare(
            `INSERT INTO nap_redirects (slug, site_slug) VALUES (?, ?)
             ON CONFLICT (slug) DO UPDATE SET site_slug = excluded.site_slug`,
          ).bind(from, to),
        ]
      : []),
    DB.prepare("DELETE FROM sites WHERE slug = ?").bind(from),
  ]);
  return true;
}

/** The current key of a nap that had this key before, if any. */
export async function findRedirect(db: D1Database, slug: string) {
  const row = await db
    .prepare(
      `SELECT nap_redirects.site_slug AS slug FROM nap_redirects
       JOIN sites ON sites.slug = nap_redirects.site_slug
       WHERE nap_redirects.slug = ?`,
    )
    .bind(slug)
    .first<{ slug: string }>();
  return row?.slug ?? null;
}

async function copySiteObjects(bucket: R2Bucket, fromSlug: string, toSlug: string) {
  const fromPrefix = `sites/${fromSlug}/`;
  const toPrefix = `sites/${toSlug}/`;
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix: fromPrefix, cursor });
    for (const item of listed.objects) {
      const source = await bucket.get(item.key);
      if (!source) continue;
      const headers = new Headers();
      source.writeHttpMetadata(headers);
      await bucket.put(item.key.replace(fromPrefix, toPrefix), source.body, {
        httpMetadata: Object.fromEntries(headers),
        customMetadata: source.customMetadata,
      });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
