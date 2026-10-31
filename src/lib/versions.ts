import { json } from "~/lib/nap-server";
import { canViewSite, isSameEmail, type Visibility } from "~/lib/site-access";

/** How a version was published. Old rows can have "" when Nap cannot tell. */
export type VersionSource = "dashboard" | "agent" | "claim" | "github";

export type VersionRecord = {
  id: string;
  /** 1 for the first upload, counting up. Restoring an old one does not renumber anything. */
  number: number;
  createdAt: string;
  uploadedByEmail: string;
  uploadedByName: string | null;
  fileCount: number;
  totalBytes: number;
  source: VersionSource | "";
  client: string;
  message: string;
  parentVersionId: string | null;
  sourceCommit: string | null;
  live: boolean;
};

export const MAX_VERSION_MESSAGE = 500;

/** The versions row for a new upload. Run it in the same batch as the change to `sites`. */
export function insertVersion(
  db: D1Database,
  version: {
    id: string;
    slug: string;
    email: string;
    fileCount: number;
    totalBytes: number;
    parentVersionId: string | null;
    source: VersionSource;
    client?: string;
    message?: string;
    /** The source repo commit it was built from. */
    sourceCommit?: string | null;
  },
) {
  return db
    .prepare(
      `INSERT INTO versions (id, site_slug, uploaded_by_email, file_count, total_bytes,
                             parent_version_id, source, client, message, source_commit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      version.id,
      version.slug,
      version.email,
      version.fileCount,
      version.totalBytes,
      version.parentVersionId,
      version.source,
      (version.client ?? "").slice(0, 80),
      (version.message ?? "").slice(0, MAX_VERSION_MESSAGE),
      version.sourceCommit || null,
    );
}

/** Newest first. */
export async function listVersions(db: D1Database, slug: string, limit = 200) {
  const { results } = await db
    .prepare(
      `SELECT versions.id,
              ROW_NUMBER() OVER (ORDER BY versions.created_at, versions.id) AS number,
              versions.created_at AS createdAt,
              versions.uploaded_by_email AS uploadedByEmail, profiles.display_name AS uploadedByName,
              versions.file_count AS fileCount, versions.total_bytes AS totalBytes,
              versions.source, versions.client, versions.message,
              versions.parent_version_id AS parentVersionId, versions.source_commit AS sourceCommit,
              versions.id = sites.current_version AS live
       FROM versions
       JOIN sites ON sites.slug = versions.site_slug
       LEFT JOIN profiles ON profiles.email = versions.uploaded_by_email
       WHERE versions.site_slug = ?
       ORDER BY versions.created_at DESC
       LIMIT ?`,
    )
    .bind(slug, limit)
    .all<Omit<VersionRecord, "live"> & { live: number }>();
  return results.map((row) => ({ ...row, live: Boolean(row.live) }));
}

/**
 * Makes an earlier version live again. Anyone who can view a nap can do this. Nothing is copied:
 * the version's files are immutable, so Nap only moves `current_version`. With
 * `requireExpectedVersion`, someone other than the owner must name the live version they replace.
 * On a site with a source repo, the live site then runs behind main until the next publish.
 */
export async function restoreVersion(
  db: D1Database,
  email: string,
  slug: string,
  body: { version?: unknown; expectedCurrentVersion?: unknown },
  options: { requireExpectedVersion?: boolean } = {},
) {
  const versionId = typeof body.version === "string" ? body.version.trim() : "";
  if (!versionId) return json({ error: "Missing version" }, { status: 400 });

  const site = await db
    .prepare(
      `SELECT slug, created_by_email AS createdByEmail,
              current_version AS currentVersion, visibility
       FROM sites WHERE slug = ?`,
    )
    .bind(slug)
    .first<{
      slug: string;
      createdByEmail: string;
      currentVersion: string;
      visibility: Visibility;
    }>();
  if (!site || !(await canViewSite(db, site, email))) {
    return json({ error: "Not found" }, { status: 404 });
  }
  const named =
    typeof body.expectedCurrentVersion === "string" && body.expectedCurrentVersion
      ? body.expectedCurrentVersion
      : null;
  if (options.requireExpectedVersion && !named && !isSameEmail(site.createdByEmail, email)) {
    return json(
      {
        error: `This nap belongs to ${site.createdByEmail}. Send the live version as expectedCurrentVersion so you don't undo someone else's change.`,
        code: "expected_version_required",
      },
      { status: 409 },
    );
  }
  const expected = named ?? site.currentVersion;
  if (expected !== site.currentVersion) {
    return json({ error: "It changed in the meantime. Reload and try again." }, { status: 409 });
  }
  if (versionId === site.currentVersion) {
    return json({ ok: true, currentVersion: versionId, changed: false });
  }

  const version = await db
    .prepare("SELECT id FROM versions WHERE id = ? AND site_slug = ?")
    .bind(versionId, slug)
    .first<{ id: string }>();
  if (!version) return json({ error: "Version not found" }, { status: 404 });

  const updated = await db
    .prepare(
      `UPDATE sites
       SET current_version = ?, updated_by_email = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE slug = ? AND current_version = ? AND management_type = 'direct'`,
    )
    .bind(versionId, email, slug, expected)
    .run();
  if (updated.meta.changes !== 1) {
    return json({ error: "It changed in the meantime. Reload and try again." }, { status: 409 });
  }
  return json({ ok: true, currentVersion: versionId, changed: true });
}

/** A version of this nap, for previews. Null when the id is not one of its versions. */
export async function findVersion(db: D1Database, slug: string, versionId: string) {
  return db
    .prepare("SELECT id FROM versions WHERE id = ? AND site_slug = ?")
    .bind(versionId, slug)
    .first<{ id: string }>();
}
