import { DEFAULT_ACCESS } from "~/lib/deployment-text";
import { ensureProfile, json, objectKey, slugify, type Identity } from "~/lib/nap-server";
import {
  canViewSite,
  isSameEmail,
  isVisibility,
  normalizeEmail,
  type Visibility,
} from "~/lib/site-access";
import {
  checkFiles,
  contentTypeForPath,
  isReservedSlug,
  isSafePath,
  pickArtifactId,
  pickGeneratedSlug,
  nextSortOrder,
  normalizePath,
  randomTheme,
  readUpload,
  rejectLargeBody,
  type SiteKind,
} from "~/lib/uploads";
import { insertVersion } from "~/lib/versions";

export const DRAFT_TTL_HOURS = 24;
const DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const MAX_REPLACES_CHAIN = 20;
const UNTITLED_ARTIFACT = "Untitled artifact";
const UNTITLED_SITE = "Untitled site";

type DraftEnv = {
  DB: D1Database;
  SITES: R2Bucket;
  DRAFT_LIMITER?: RateLimit;
};

type DraftRow = {
  id: string;
  kind: SiteKind;
  title: string;
  slug: string;
  replacesDraftId: string | null;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  claimedByEmail: string | null;
  siteSlug: string | null;
};

type TargetSite = {
  slug: string;
  kind: SiteKind;
  title: string;
  currentVersion: string;
  createdByEmail: string;
  sourceRepo: string | null;
  visibility: Visibility;
};

export function isDraftId(id: string) {
  return DRAFT_ID_PATTERN.test(id);
}

function draftKey(id: string, path: string) {
  return `drafts/${id}/${path}`;
}

function newDraftId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function isExpired(draft: Pick<DraftRow, "expiresAt">) {
  return Date.parse(draft.expiresAt) <= Date.now();
}

/** Accepts a bare claim id or a full claim URL. */
function parseDraftRef(value: string) {
  const id = value.trim().replace(/\/+$/, "").split("/").pop() ?? "";
  return isDraftId(id) ? id : null;
}

/**
 * POST /_nap/drafts
 *
 * The only unauthenticated write in Nap. Cloudflare Access must bypass this exact path.
 * Nothing uploaded here is served until a signed-in person claims it.
 *
 * Inputs (query string or form fields):
 * - kind: "artifact" (default without slug) or "site" (default with slug)
 * - title: suggested name
 * - slug: suggested subdomain for a site
 * - replaces: claim id (or URL) of an earlier draft; publishing can update what it became
 */
export async function handleCreateDraft(env: DraftEnv, request: Request) {
  if (request.method !== "POST") {
    return json(
      { error: "Use POST to upload a draft" },
      { status: 405, headers: { allow: "POST" } },
    );
  }

  if (env.DRAFT_LIMITER) {
    const key = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.DRAFT_LIMITER.limit({ key });
    if (!success) return json({ error: "Too many uploads. Wait a minute." }, { status: 429 });
  }

  const tooLarge = rejectLargeBody(request);
  if (tooLarge) return tooLarge;

  const url = new URL(request.url);
  const parsed = await readUpload(request, url, ["title", "slug", "kind", "replaces"]);
  if (parsed instanceof Response) return parsed;
  const { files } = parsed;
  const title = parsed.fields.title.slice(0, 120);
  const slug = slugify(parsed.fields.slug);
  const fields = parsed.fields;

  const checked = checkFiles(files);
  if (checked instanceof Response) return checked;
  const { totalBytes } = checked;

  let replacesDraftId: string | null = null;
  let kind: SiteKind;
  if (fields.replaces) {
    replacesDraftId = parseDraftRef(fields.replaces);
    const replaced = replacesDraftId ? await getDraft(env.DB, replacesDraftId) : null;
    if (!replaced) return json({ error: "replaces: draft not found" }, { status: 404 });
    // An update keeps the kind of what it updates.
    kind = replaced.kind;
  } else if (fields.kind === "site" || fields.kind === "artifact") {
    kind = fields.kind;
  } else if (fields.kind) {
    return json({ error: 'kind must be "artifact" or "site"' }, { status: 400 });
  } else {
    kind = slug ? "site" : "artifact";
  }

  const id = newDraftId();
  for (const file of files) {
    await env.SITES.put(draftKey(id, file.path), file.body.stream(), {
      httpMetadata: { contentType: contentTypeForPath(file.path) },
    });
  }

  const expiresAt = new Date(Date.now() + DRAFT_TTL_HOURS * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    // Drop metadata for old drafts. An R2 lifecycle rule on `drafts/` removes their files.
    env.DB.prepare(
      "DELETE FROM drafts WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')",
    ),
    env.DB.prepare(
      `INSERT INTO drafts (id, kind, title, slug, replaces_draft_id, file_count, total_bytes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      kind,
      title,
      kind === "site" ? slug : "",
      replacesDraftId,
      files.length,
      totalBytes,
      expiresAt,
    ),
  ]);

  return json(
    {
      ok: true,
      id,
      kind,
      claimUrl: `${url.origin}/claim/${id}`,
      expiresAt,
      fileCount: files.length,
      totalBytes,
      message:
        `Draft uploaded. Give the claimUrl to the user; they open it to publish. ` +
        `To publish a new version later, upload again with replaces=${id}.`,
    },
    { status: 201 },
  );
}

async function getDraft(db: D1Database, id: string) {
  if (!isDraftId(id)) return null;
  return db
    .prepare(
      `SELECT id, kind, title, slug, replaces_draft_id AS replacesDraftId,
              file_count AS fileCount, total_bytes AS totalBytes,
              created_at AS createdAt, expires_at AS expiresAt, claimed_at AS claimedAt,
              claimed_by_email AS claimedByEmail, site_slug AS siteSlug
       FROM drafts WHERE id = ?`,
    )
    .bind(id)
    .first<DraftRow>();
}

async function getTargetSite(db: D1Database, slug: string) {
  return db
    .prepare(
      `SELECT slug, kind, title, current_version AS currentVersion,
              created_by_email AS createdByEmail, source_repo AS sourceRepo, visibility
       FROM sites WHERE slug = ?`,
    )
    .bind(slug)
    .first<TargetSite>();
}

/**
 * Follows `replaces` links back to the first draft that was published, and returns that site.
 * An unpublished draft in the middle of the chain is skipped: its newer draft supersedes it.
 */
async function resolveReplacedSite(db: D1Database, draft: DraftRow) {
  let ref = draft.replacesDraftId;
  for (let step = 0; ref && step < MAX_REPLACES_CHAIN; step++) {
    const previous = await getDraft(db, ref);
    if (!previous) return null;
    if (previous.siteSlug) return getTargetSite(db, previous.siteSlug);
    ref = previous.replacesDraftId;
  }
  return null;
}

/** The site this draft would update: from `replaces`, or for sites, an existing slug. */
async function findTargetSite(db: D1Database, draft: DraftRow) {
  const replaced = await resolveReplacedSite(db, draft);
  if (replaced) return replaced;
  if (draft.kind === "site" && draft.slug) return getTargetSite(db, draft.slug);
  return null;
}

/**
 * Anyone who can view a nap may publish a new version of it. Not from a claim link when the site
 * has a source repo: its versions must come from a pushed commit.
 */
async function canUpdate(db: D1Database, site: TargetSite, identity: Identity) {
  return !site.sourceRepo && canViewSite(db, site, identity.email);
}

/** GET /api/drafts/:id — what the claim page shows. */
export async function describeDraft(db: D1Database, identity: Identity, id: string) {
  const draft = await getDraft(db, id);
  if (!draft) return json({ error: "Draft not found" }, { status: 404 });

  const claimedByMe = draft.claimedByEmail
    ? isSameEmail(draft.claimedByEmail, identity.email)
    : false;

  let suggestedSite: {
    slug: string;
    kind: SiteKind;
    title: string;
    currentVersion: string;
    /** This person may publish the draft as a new version of it. */
    canUpdate: boolean;
    /** Only the owner sees and changes who can view it. */
    isOwner: boolean;
    visibility?: Visibility;
    viewerEmails?: Array<string>;
  } | null = null;

  if (!draft.claimedAt) {
    const site = await findTargetSite(db, draft);
    if (site && (await canUpdate(db, site, identity))) {
      const isOwner = isSameEmail(site.createdByEmail, identity.email);
      const viewers = isOwner
        ? await db
            .prepare("SELECT email FROM site_viewers WHERE site_slug = ? ORDER BY email")
            .bind(site.slug)
            .all<{ email: string }>()
        : null;
      suggestedSite = {
        slug: site.slug,
        kind: site.kind,
        title: site.title,
        currentVersion: site.currentVersion,
        canUpdate: true,
        isOwner,
        ...(viewers && {
          visibility: site.visibility,
          viewerEmails: viewers.results.map((row) => row.email),
        }),
      };
    } else if (site && site.kind === "site" && draft.kind === "site") {
      // The suggested subdomain is taken. Say nothing else about a site they may not see.
      suggestedSite = {
        slug: site.slug,
        kind: "site",
        title: "",
        currentVersion: "",
        canUpdate: false,
        isOwner: false,
      };
    }
  }

  // Tell the claim page when the agent has uploaded a newer version of this draft.
  const newer = draft.claimedAt
    ? null
    : await db
        .prepare(
          "SELECT id FROM drafts WHERE replaces_draft_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .bind(draft.id)
        .first<{ id: string }>();

  return json(
    {
      draft: {
        id: draft.id,
        kind: draft.kind,
        title: draft.title,
        slug: draft.slug,
        fileCount: draft.fileCount,
        totalBytes: draft.totalBytes,
        createdAt: draft.createdAt,
        expiresAt: draft.expiresAt,
        expired: isExpired(draft),
        claimed: Boolean(draft.claimedAt),
        claimedByMe,
        siteSlug: claimedByMe ? draft.siteSlug : null,
        supersededBy: newer?.id ?? null,
      },
      suggestedSite,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * GET /api/drafts/:id/preview/* — serves unclaimed draft files for the claim page iframe.
 * The CSP sandbox gives the document an opaque origin, so draft code cannot act as the
 * signed-in person on the Nap dashboard origin.
 */
export async function serveDraftFile(env: DraftEnv, id: string, path: string) {
  const draft = await getDraft(env.DB, id);
  if (!draft || draft.claimedAt || isExpired(draft)) {
    return new Response("Draft not found", { status: 404 });
  }

  const clean = normalizePath(path);
  const filePath = !clean || clean.endsWith("/") ? `${clean}index.html` : clean;
  if (!isSafePath(filePath)) return new Response("Not found", { status: 404 });

  const object = await env.SITES.get(draftKey(id, filePath));
  if (!object) return new Response("File not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-security-policy",
    "sandbox allow-scripts allow-forms allow-popups allow-modals",
  );
  return new Response(object.body, { headers });
}

/**
 * POST /api/drafts/:id — publishes a draft.
 * - replace: true publishes a new version of a site or artifact the person can view. Only the
 *   owner may change its name or who can view it at the same time.
 * - Otherwise it creates a new site (chosen slug, or one made from the title) or a new
 *   artifact (always a random id).
 */
export async function claimDraft(
  env: DraftEnv,
  identity: Identity,
  id: string,
  body: {
    title?: unknown;
    slug?: unknown;
    expectedCurrentVersion?: unknown;
    replace?: unknown;
    visibility?: unknown;
    emails?: unknown;
  },
) {
  const draft = await getDraft(env.DB, id);
  if (!draft) return json({ error: "Draft not found" }, { status: 404 });
  if (draft.claimedAt) return json({ error: "This draft is already published" }, { status: 409 });
  if (isExpired(draft)) return json({ error: "This draft has expired" }, { status: 410 });

  const replace = body.replace === true;
  const requestedSlug = slugify(typeof body.slug === "string" ? body.slug : "");
  let requestedTitle = (typeof body.title === "string" ? body.title : "").trim().slice(0, 120);
  const expectedCurrentVersion =
    typeof body.expectedCurrentVersion === "string" ? body.expectedCurrentVersion : null;

  // New sites and artifacts get the default access. For updates, no visibility means "keep it".
  let visibility: Visibility | null = isVisibility(body.visibility)
    ? body.visibility
    : replace
      ? null
      : DEFAULT_ACCESS;
  const viewerEmails =
    visibility === "selected" && Array.isArray(body.emails)
      ? [
          ...new Set(
            body.emails
              .filter((value): value is string => typeof value === "string")
              .map(normalizeEmail)
              .filter(Boolean),
          ),
        ]
      : [];
  if (visibility === "selected" && viewerEmails.length === 0) {
    return json({ error: "Add at least one person" }, { status: 400 });
  }

  await ensureProfile(env.DB, identity);

  let slug: string | null;
  let kind: SiteKind;
  let existing: TargetSite | null = null;
  if (replace) {
    existing = requestedSlug ? await getTargetSite(env.DB, requestedSlug) : null;
    if (!existing || !(await canUpdate(env.DB, existing, identity))) {
      return json(
        {
          error: existing?.sourceRepo
            ? "This site's source is in a Nap source repo. Ask the agent to push and publish instead."
            : "You can only update sites you can view",
        },
        { status: 403 },
      );
    }
    if (!isSameEmail(existing.createdByEmail, identity.email)) {
      // Only the owner changes who can view it or renames it.
      visibility = null;
      requestedTitle = "";
    }
    if (expectedCurrentVersion && existing.currentVersion !== expectedCurrentVersion) {
      return json(
        { error: "It changed while you were here. Reload and try again." },
        { status: 409 },
      );
    }
    slug = existing.slug;
    kind = existing.kind;
  } else if (draft.kind === "artifact" || !requestedSlug) {
    // Artifacts get a random id, and sites without a chosen URL one made from the title, below.
    slug = null;
    kind = draft.kind;
  } else {
    if (isReservedSlug(requestedSlug)) {
      return json({ error: "That URL is reserved" }, { status: 409 });
    }
    if (await getTargetSite(env.DB, requestedSlug)) {
      return json({ error: "That URL is already taken" }, { status: 409 });
    }
    slug = requestedSlug;
    kind = "site";
  }

  const title =
    requestedTitle ||
    existing?.title ||
    draft.title ||
    (kind === "artifact" ? UNTITLED_ARTIFACT : UNTITLED_SITE);
  const isTaken = async (candidate: string) => Boolean(await getTargetSite(env.DB, candidate));
  slug ??=
    kind === "artifact" ? await pickArtifactId(isTaken) : await pickGeneratedSlug(title, isTaken);

  // Take the draft first so two tabs cannot publish it twice.
  const taken = await env.DB.prepare(
    `UPDATE drafts SET claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), claimed_by_email = ?
     WHERE id = ? AND claimed_at IS NULL`,
  )
    .bind(identity.email, id)
    .run();
  if (taken.meta.changes !== 1) {
    return json({ error: "This draft is already published" }, { status: 409 });
  }

  const release = () =>
    env.DB.prepare("UPDATE drafts SET claimed_at = NULL, claimed_by_email = NULL WHERE id = ?")
      .bind(id)
      .run();

  const version = crypto.randomUUID();
  try {
    const copied = await copyDraftFiles(env.SITES, id, slug, version);
    if (copied.keys.length !== draft.fileCount) {
      await release();
      return json({ error: "Draft files are missing. Upload again." }, { status: 410 });
    }

    const versionRow = insertVersion(env.DB, {
      id: version,
      slug,
      email: identity.email,
      fileCount: copied.keys.length,
      totalBytes: copied.totalBytes,
      parentVersionId: existing?.currentVersion ?? null,
      source: "claim",
    });
    const draftRow = env.DB.prepare(
      "UPDATE drafts SET site_slug = ?, version_id = ? WHERE id = ?",
    ).bind(slug, version, id);
    const accessRows = visibility
      ? [
          env.DB.prepare("UPDATE sites SET visibility = ? WHERE slug = ?").bind(visibility, slug),
          env.DB.prepare("DELETE FROM site_viewers WHERE site_slug = ?").bind(slug),
          ...viewerEmails.map((email) =>
            env.DB.prepare("INSERT INTO site_viewers (site_slug, email) VALUES (?, ?)").bind(
              slug,
              email,
            ),
          ),
        ]
      : [];

    if (existing) {
      const updated = await env.DB.prepare(
        `UPDATE sites
         SET title = ?, updated_by_email = ?, current_version = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE slug = ? AND current_version = ? AND management_type = 'direct'`,
      )
        .bind(title, identity.email, version, slug, existing.currentVersion)
        .run();
      if (updated.meta.changes !== 1) {
        await release();
        return json(
          { error: "It changed while you were here. Reload and try again." },
          { status: 409 },
        );
      }
      await env.DB.batch([versionRow, draftRow, ...accessRows]);
    } else {
      await env.DB.batch([
        env.DB.prepare(
          // Private and unlisted. Artifacts get the Nap toolbar; sites can turn it on.
          `INSERT INTO sites (slug, kind, title, created_by_email, updated_by_email, current_version,
                              sort_order, theme_json, visibility, listed, toolbar)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'private', 0, ?)`,
        ).bind(
          slug,
          kind,
          title,
          identity.email,
          identity.email,
          version,
          await nextSortOrder(env.DB),
          JSON.stringify(randomTheme()),
          kind === "artifact" ? 1 : 0,
        ),
        versionRow,
        draftRow,
        ...accessRows,
      ]);
    }

    await env.SITES.delete(copied.sourceKeys).catch(() => undefined);
  } catch (error) {
    await release();
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE|PRIMARY KEY/i.test(message)) {
      return json({ error: "That URL is already taken" }, { status: 409 });
    }
    throw error;
  }

  return json({
    ok: true,
    site: {
      slug,
      kind,
      title,
      currentVersion: version,
      visibility: visibility ?? existing?.visibility,
      replaced: Boolean(existing),
    },
  });
}

async function copyDraftFiles(bucket: R2Bucket, id: string, slug: string, version: string) {
  const prefix = `drafts/${id}/`;
  const keys: Array<string> = [];
  const sourceKeys: Array<string> = [];
  let totalBytes = 0;
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const item of listed.objects) {
      const source = await bucket.get(item.key);
      if (!source) continue;
      const path = item.key.slice(prefix.length);
      const target = objectKey(slug, version, path);
      await bucket.put(target, source.body, {
        httpMetadata: { contentType: source.httpMetadata?.contentType ?? contentTypeForPath(path) },
      });
      keys.push(target);
      sourceKeys.push(item.key);
      totalBytes += item.size;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return { keys, sourceKeys, totalBytes };
}
