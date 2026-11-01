import { Effect } from "effect";
import { Database } from "~/server/database";

export type Identity = {
  email: string;
  name: string;
};

export type SiteRecord = {
  slug: string;
  kind: "site" | "artifact";
  /** The site's source is in a Nap source repo; dashboard uploads are off. */
  hasSource: boolean;
  title: string;
  createdByEmail: string;
  updatedByEmail: string;
  currentVersion: string;
  sortOrder: number;
  theme: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  viewCount: number;
  lastViewedAt: string | null;
  authorDisplayName: string | null;
  authorUsername: string | null;
  visibility: "everyone" | "private" | "selected";
  /** Only for the owner. Empty for everyone else. */
  viewerEmails: Array<string>;
  /** Unused since every site shared with everyone shows on the dashboard. */
  listed: boolean;
  /** Framed under the Nap toolbar. */
  toolbar: boolean;
  /** The caller is in the invite list. */
  invited: boolean;
};

export function getIdentity(request?: Request): Identity {
  const email =
    request?.headers.get("cf-access-authenticated-user-email") ??
    request?.headers.get("x-nap-dev-email") ??
    "elias@example.test";

  const name = request?.headers.get("cf-access-authenticated-user-name") ?? prettifyEmail(email);
  return { email, name };
}

/**
 * Creates the profile on first use and records that the person used Nap through Access. Agent
 * tokens stop working when their owner has not been seen for 30 days. Call this only for
 * requests that Access protects, never from the agent API or draft uploads.
 */
export const ensureProfile = Effect.fn("ensureProfile")(function* (identity: Identity) {
  const db = yield* Database;
  yield* db.run(
    `INSERT INTO profiles (email, display_name, avatar_color, last_seen_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at
     WHERE profiles.last_seen_at IS NULL
        OR profiles.last_seen_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')`,
    identity.email,
    identity.name,
    colorFromEmail(identity.email),
  );
});

/**
 * The person behind an Access-protected request, with their profile created or touched. Never
 * for paths that Access bypasses.
 */
export const signedIn = Effect.fn("signedIn")(function* (request: Request) {
  const identity = getIdentity(request);
  yield* ensureProfile(identity);
  return identity;
});

/**
 * What the caller may see on the dashboard:
 * - their own sites and artifacts, listed or not;
 * - sites shared with everyone;
 * - sites that invite them.
 * Other people's artifacts are never listed. They are shared by link.
 */
export const listSites = Effect.fn("listSites")(function* (identity: Identity) {
  const db = yield* Database;
  const results = yield* db.all<{
    slug: string;
    kind: "site" | "artifact";
    hasSource: number;
    title: string;
    createdByEmail: string;
    updatedByEmail: string;
    currentVersion: string;
    sortOrder: number;
    themeJson: string;
    createdAt: string;
    updatedAt: string;
    viewCount: number;
    lastViewedAt: string | null;
    authorDisplayName: string | null;
    authorUsername: string | null;
    visibility: "everyone" | "private" | "selected";
    listed: number;
    toolbar: number;
    invited: number;
    viewerEmails: string | null;
  }>(
    `WITH mine AS (
         SELECT site_slug FROM site_viewers WHERE lower(email) = lower(?1)
       )
       SELECT
        sites.slug,
        sites.kind,
        sites.source_repo IS NOT NULL AS hasSource,
        sites.title,
        sites.created_by_email AS createdByEmail,
        sites.updated_by_email AS updatedByEmail,
        sites.current_version AS currentVersion,
        sites.sort_order AS sortOrder,
        sites.theme_json AS themeJson,
        sites.created_at AS createdAt,
        sites.updated_at AS updatedAt,
        sites.view_count AS viewCount,
        sites.last_viewed_at AS lastViewedAt,
        profiles.display_name AS authorDisplayName,
        profiles.username AS authorUsername,
        sites.visibility,
        sites.listed,
        sites.toolbar,
        sites.slug IN (SELECT site_slug FROM mine) AS invited,
        CASE WHEN lower(sites.created_by_email) = lower(?1) THEN
          (SELECT group_concat(email) FROM site_viewers WHERE site_viewers.site_slug = sites.slug)
        END AS viewerEmails
      FROM sites
      LEFT JOIN profiles ON profiles.email = sites.updated_by_email
      WHERE lower(sites.created_by_email) = lower(?1)
         OR (sites.kind = 'site' AND (
               sites.visibility = 'everyone'
            OR (sites.visibility = 'selected' AND sites.slug IN (SELECT site_slug FROM mine))
         ))
      ORDER BY sites.sort_order ASC, sites.created_at ASC`,
    identity.email,
  );

  return results.map(
    (row): SiteRecord => ({
      slug: row.slug,
      kind: row.kind,
      hasSource: Boolean(row.hasSource),
      title: row.title,
      createdByEmail: row.createdByEmail,
      updatedByEmail: row.updatedByEmail,
      currentVersion: row.currentVersion,
      sortOrder: row.sortOrder,
      theme: safeJson(row.themeJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      viewCount: row.viewCount,
      lastViewedAt: row.lastViewedAt,
      authorDisplayName: row.authorDisplayName,
      authorUsername: row.authorUsername,
      visibility: row.visibility,
      viewerEmails: row.viewerEmails ? row.viewerEmails.split(",") : [],
      listed: Boolean(row.listed),
      toolbar: Boolean(row.toolbar),
      invited: Boolean(row.invited),
    }),
  );
});

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 32);
}

export function objectKey(slug: string, version: string, path: string) {
  return `sites/${slug}/versions/${version}/${path.replace(/^\/+/, "")}`;
}

function safeJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function prettifyEmail(email: string) {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function colorFromEmail(email: string) {
  let hash = 0;
  for (const char of email) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash} 70% 48%)`;
}
