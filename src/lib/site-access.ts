import { ensureProfile, getIdentity, json, type Identity } from "~/lib/nap-server";
import { listPeople } from "~/lib/people";

export type Visibility = "everyone" | "private" | "selected";

type SiteAccessEnv = {
  DB: D1Database;
};

export function isVisibility(value: unknown): value is Visibility {
  return value === "everyone" || value === "private" || value === "selected";
}

export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

export async function getSiteOwner(db: D1Database, slug: string) {
  return db
    .prepare(
      `SELECT created_by_email AS createdByEmail, visibility, kind,
              source_repo AS sourceRepo
       FROM sites WHERE slug = ?`,
    )
    .bind(slug)
    .first<{
      createdByEmail: string;
      visibility: Visibility;
      kind: "site" | "artifact";
      sourceRepo: string | null;
    }>();
}

export function isSameEmail(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether this person may view a nap. Anyone who can view a nap may also publish new versions
 * of it and restore old ones. Only the owner changes who can view it, its settings, its URL,
 * and its owner, or deletes it.
 */
export async function canViewSite(
  db: D1Database,
  site: { slug: string; visibility: Visibility; createdByEmail: string },
  email: string,
) {
  if (site.visibility === "everyone" || isSameEmail(site.createdByEmail, email)) return true;
  if (site.visibility !== "selected") return false;
  const viewer = await db
    .prepare("SELECT 1 FROM site_viewers WHERE site_slug = ? AND lower(email) = lower(?)")
    .bind(site.slug, email)
    .first();
  return Boolean(viewer);
}

/**
 * Changes who can view a site. Only the owner may call this.
 * Returns a JSON response so dashboard routes and site-host routes behave the same.
 */
export async function updateSiteAccess(
  db: D1Database,
  identity: Identity,
  slug: string,
  body: { visibility?: unknown; emails?: unknown },
) {
  if (!isVisibility(body.visibility)) {
    return json({ error: "Invalid visibility" }, { status: 400 });
  }

  const site = await getSiteOwner(db, slug);
  if (!site) return json({ error: "Site not found" }, { status: 404 });
  if (!isSameEmail(site.createdByEmail, identity.email)) {
    return json({ error: "Only the site owner can change access" }, { status: 403 });
  }

  const rawEmails = Array.isArray(body.emails) ? body.emails : [];
  const emails = [
    ...new Set(
      rawEmails
        .filter((value): value is string => typeof value === "string")
        .map(normalizeEmail)
        .filter(Boolean),
    ),
  ];
  if (body.visibility === "selected" && emails.length === 0) {
    return json({ error: "Add at least one person" }, { status: 400 });
  }

  await db.batch([
    db
      .prepare(
        `UPDATE sites
         SET visibility = ?, updated_by_email = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE slug = ?`,
      )
      .bind(body.visibility, identity.email, slug),
    db.prepare("DELETE FROM site_viewers WHERE site_slug = ?").bind(slug),
    ...emails.map((email) =>
      db.prepare("INSERT INTO site_viewers (site_slug, email) VALUES (?, ?)").bind(slug, email),
    ),
  ]);

  return json({ ok: true, visibility: body.visibility, viewerEmails: emails });
}

/**
 * Gives a nap to someone else. Only the owner may call this. The new owner must have used Nap, so
 * a typo cannot hand it to nobody. The previous owner keeps access as an invited person: a private
 * nap becomes shared with them, so the change takes nothing away from anyone.
 */
export async function transferOwnership(
  db: D1Database,
  identity: Identity,
  slug: string,
  body: { email?: unknown },
) {
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  if (!email) return json({ error: "Enter an email address" }, { status: 400 });

  const site = await getSiteOwner(db, slug);
  if (!site) return json({ error: "Site not found" }, { status: 404 });
  if (!isSameEmail(site.createdByEmail, identity.email)) {
    return json({ error: "Only the owner can transfer it" }, { status: 403 });
  }
  if (isSameEmail(email, site.createdByEmail)) {
    return json({ error: "They already own it" }, { status: 400 });
  }
  const profile = await db
    .prepare("SELECT email FROM profiles WHERE lower(email) = ?")
    .bind(email)
    .first<{ email: string }>();
  if (!profile) {
    return json(
      { error: "No one with that email has used Nap yet. Ask them to open Nap once." },
      { status: 400 },
    );
  }

  const previous = site.createdByEmail.toLowerCase();
  const visibility: Visibility = site.visibility === "private" ? "selected" : site.visibility;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE sites
         SET created_by_email = ?, visibility = ?, updated_by_email = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE slug = ? AND lower(created_by_email) = ?`,
      )
      .bind(profile.email, visibility, identity.email, slug, previous),
    // The owner always has access, so an invite for them is redundant. Both statements only act
    // if the update above happened.
    db
      .prepare(
        `DELETE FROM site_viewers WHERE site_slug = ?1 AND lower(email) = ?2
           AND EXISTS (SELECT 1 FROM sites WHERE slug = ?1 AND lower(created_by_email) = ?2)`,
      )
      .bind(slug, email),
    ...(visibility === "selected"
      ? [
          db
            .prepare(
              `INSERT OR IGNORE INTO site_viewers (site_slug, email)
               SELECT ?1, ?2 FROM sites WHERE slug = ?1 AND lower(created_by_email) = ?3`,
            )
            .bind(slug, previous, email),
        ]
      : []),
  ]);
  if (results[0].meta.changes !== 1) {
    return json({ error: "It changed in the meantime. Reload and try again." }, { status: 409 });
  }
  return json({ ok: true, owner: profile.email, visibility });
}

/**
 * Handles `/_nap/access` on a site host. The share widget uses it.
 * GET tells the widget whether to show itself. For the owner it also returns share suggestions.
 * PATCH changes access.
 */
export async function handleSiteAccessRequest(env: SiteAccessEnv, slug: string, request: Request) {
  const identity = getIdentity(request);
  const site = await getSiteOwner(env.DB, slug);
  if (!site) return json({ error: "Site not found" }, { status: 404, headers: noStore });

  const isOwner = isSameEmail(site.createdByEmail, identity.email);

  if (request.method === "GET") {
    if (!isOwner) return json({ canManage: false }, { headers: noStore });
    const [{ results }, people] = await Promise.all([
      env.DB.prepare("SELECT email FROM site_viewers WHERE site_slug = ? ORDER BY email")
        .bind(slug)
        .all<{ email: string }>(),
      listPeople(env.DB, identity),
    ]);
    return json(
      {
        canManage: true,
        visibility: site.visibility,
        viewerEmails: results.map((row) => row.email),
        ...people,
      },
      { headers: noStore },
    );
  }

  if (request.method === "PATCH") {
    // A JSON body forces a CORS preflight, which Nap never answers, so other origins cannot call this.
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return json({ error: "Expected JSON" }, { status: 415 });
    }
    if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
    await ensureProfile(env.DB, identity);
    const body = (await request.json().catch(() => ({}))) as {
      visibility?: unknown;
      emails?: unknown;
    };
    return updateSiteAccess(env.DB, identity, slug, body);
  }

  return json({ error: "Method not allowed" }, { status: 405 });
}

export function isCrossSite(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  return Boolean(site && site !== "same-origin" && site !== "none");
}

const noStore = { "cache-control": "no-store" };
