import { Effect, Predicate, Schema } from "effect";
import { ensureProfile, getIdentity, type Identity } from "~/lib/nap-server";
import { listPeople } from "~/lib/people";
import { Database, sql } from "~/server/database";
import {
  decodeOr,
  fail,
  HttpError,
  json,
  noStore,
  readJsonObject,
  requireJsonBody,
  requireSameSite,
} from "~/server/http";

export { isCrossSite } from "~/server/http";

export const Visibility = Schema.Literals(["everyone", "private", "selected"]);
export type Visibility = typeof Visibility.Type;

export const isVisibility = Schema.is(Visibility);

export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

/** The valid addresses in an untrusted list, normalized and without duplicates. */
export function normalizeEmails(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(Predicate.isString).map(normalizeEmail).filter(Boolean))];
}

export type SiteOwner = {
  createdByEmail: string;
  visibility: Visibility;
  kind: "site" | "artifact";
  sourceRepo: string | null;
};

export const getSiteOwner = Effect.fn("getSiteOwner")(function* (slug: string) {
  const db = yield* Database;
  return yield* db.first<SiteOwner>(
    `SELECT created_by_email AS createdByEmail, visibility, kind,
            source_repo AS sourceRepo
     FROM sites WHERE slug = ?`,
    slug,
  );
});

export function isSameEmail(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether this person may view a nap. Anyone who can view a nap may also publish new versions
 * of it and restore old ones. Only the owner changes who can view it, its settings, its URL,
 * and its owner, or deletes it.
 */
export const canViewSite = Effect.fn("canViewSite")(function* (
  site: { slug: string; visibility: Visibility; createdByEmail: string },
  email: string,
) {
  if (site.visibility === "everyone" || isSameEmail(site.createdByEmail, email)) return true;
  if (site.visibility !== "selected") return false;
  const db = yield* Database;
  const viewer = yield* db.first(
    "SELECT 1 FROM site_viewers WHERE site_slug = ? AND lower(email) = lower(?)",
    site.slug,
    email,
  );
  return Boolean(viewer);
});

/**
 * Changes who can view a site. Only the owner may call this.
 * Answers with JSON, so dashboard routes and site-host routes behave the same.
 */
export const updateSiteAccess = Effect.fn("updateSiteAccess")(function* (
  identity: Identity,
  slug: string,
  body: { visibility?: unknown; emails?: unknown },
) {
  const visibility = yield* decodeOr(
    Visibility,
    () => new HttpError({ status: 400, body: { error: "Invalid visibility" } }),
  )(body.visibility);

  const site = yield* getSiteOwner(slug);
  if (!site) return yield* fail(404, "Site not found");
  if (!isSameEmail(site.createdByEmail, identity.email)) {
    return yield* fail(403, "Only the site owner can change access");
  }

  const emails = normalizeEmails(body.emails);
  if (visibility === "selected" && emails.length === 0) {
    return yield* fail(400, "Add at least one person");
  }

  const db = yield* Database;
  yield* db.batch([
    sql(
      `UPDATE sites
       SET visibility = ?, updated_by_email = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE slug = ?`,
      visibility,
      identity.email,
      slug,
    ),
    sql("DELETE FROM site_viewers WHERE site_slug = ?", slug),
    ...emails.map((email) =>
      sql("INSERT INTO site_viewers (site_slug, email) VALUES (?, ?)", slug, email),
    ),
  ]);

  return json({ ok: true, visibility, viewerEmails: emails });
});

/**
 * Gives a nap to someone else. Only the owner may call this. The new owner must have used Nap, so
 * a typo cannot hand it to nobody. The previous owner keeps access as an invited person: a private
 * nap becomes shared with them, so the change takes nothing away from anyone.
 */
export const transferOwnership = Effect.fn("transferOwnership")(function* (
  identity: Identity,
  slug: string,
  body: { email?: unknown },
) {
  const email = Predicate.isString(body.email) ? normalizeEmail(body.email) : "";
  if (!email) return yield* fail(400, "Enter an email address");

  const site = yield* getSiteOwner(slug);
  if (!site) return yield* fail(404, "Site not found");
  if (!isSameEmail(site.createdByEmail, identity.email)) {
    return yield* fail(403, "Only the owner can transfer it");
  }
  if (isSameEmail(email, site.createdByEmail)) {
    return yield* fail(400, "They already own it");
  }
  const db = yield* Database;
  const profile = yield* db.first<{ email: string }>(
    "SELECT email FROM profiles WHERE lower(email) = ?",
    email,
  );
  if (!profile) {
    return yield* fail(400, "No one with that email has used Nap yet. Ask them to open Nap once.");
  }

  const previous = site.createdByEmail.toLowerCase();
  const visibility: Visibility = site.visibility === "private" ? "selected" : site.visibility;
  const results = yield* db.batch([
    sql(
      `UPDATE sites
       SET created_by_email = ?, visibility = ?, updated_by_email = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE slug = ? AND lower(created_by_email) = ?`,
      profile.email,
      visibility,
      identity.email,
      slug,
      previous,
    ),
    // The owner always has access, so an invite for them is redundant. Both statements only act
    // if the update above happened.
    sql(
      `DELETE FROM site_viewers WHERE site_slug = ?1 AND lower(email) = ?2
         AND EXISTS (SELECT 1 FROM sites WHERE slug = ?1 AND lower(created_by_email) = ?2)`,
      slug,
      email,
    ),
    ...(visibility === "selected"
      ? [
          sql(
            `INSERT OR IGNORE INTO site_viewers (site_slug, email)
             SELECT ?1, ?2 FROM sites WHERE slug = ?1 AND lower(created_by_email) = ?3`,
            slug,
            previous,
            email,
          ),
        ]
      : []),
  ]);
  if (results[0].changes !== 1) {
    return yield* fail(409, "It changed in the meantime. Reload and try again.");
  }
  return json({ ok: true, owner: profile.email, visibility });
});

/**
 * Handles `/_nap/access` on a site host. The share widget uses it.
 * GET tells the widget whether to show itself. For the owner it also returns share suggestions.
 * PATCH changes access.
 */
export const handleSiteAccessRequest = Effect.fn("handleSiteAccessRequest")(function* (
  slug: string,
  request: Request,
) {
  const identity = getIdentity(request);
  const site = yield* getSiteOwner(slug);
  if (!site) return yield* fail(404, "Site not found", {}, noStore);

  const isOwner = isSameEmail(site.createdByEmail, identity.email);

  if (request.method === "GET") {
    if (!isOwner) return json({ canManage: false }, { headers: noStore });
    const db = yield* Database;
    const [viewers, people] = yield* Effect.all(
      [
        db.all<{ email: string }>(
          "SELECT email FROM site_viewers WHERE site_slug = ? ORDER BY email",
          slug,
        ),
        listPeople(identity),
      ],
      { concurrency: "unbounded" },
    );
    return json(
      {
        canManage: true,
        visibility: site.visibility,
        viewerEmails: viewers.map((row) => row.email),
        ...people,
      },
      { headers: noStore },
    );
  }

  if (request.method === "PATCH") {
    yield* requireJsonBody(request);
    yield* requireSameSite(request);
    yield* ensureProfile(identity);
    const body = yield* readJsonObject(request);
    return yield* updateSiteAccess(identity, slug, body);
  }

  return yield* fail(405, "Method not allowed");
});
