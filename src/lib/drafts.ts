import { Effect, Predicate } from "effect";
import { DEFAULT_ACCESS } from "~/lib/deployment-text";
import type { AgentIdentity } from "~/lib/agent-auth";
import { ensureProfile, objectKey, slugify, type Identity } from "~/lib/nap-server";
import {
  canViewSite,
  isSameEmail,
  isVisibility,
  normalizeEmails,
  type Visibility,
} from "~/lib/site-access";
import {
  checkFiles,
  contentTypeForPath,
  isReservedSlug,
  isSafePath,
  napShape,
  pickArtifactId,
  pickGeneratedSlug,
  nextSortOrder,
  normalizePath,
  randomTheme,
  readUpload,
  rejectLargeBody,
  UNTITLED_NAP,
  type SiteKind,
} from "~/lib/uploads";
import { insertVersion } from "~/lib/versions";
import { Database, sql } from "~/server/database";
import { fail, failText, json, noStore } from "~/server/http";
import { objectHeaders, Storage } from "~/server/storage";

export const DRAFT_TTL_HOURS = 24;
const DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const MAX_REPLACES_CHAIN = 20;

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
  createdByEmail: string | null;
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

/** Only the person whose token uploaded a draft may see or publish it. */
function isUploader(draft: Pick<DraftRow, "createdByEmail">, identity: Identity) {
  return draft.createdByEmail ? isSameEmail(draft.createdByEmail, identity.email) : false;
}

const NOT_YOURS = "Only the person whose agent uploaded this draft can open it.";

/**
 * POST /_nap/api/drafts (agent token)
 *
 * Uploads a draft for the token's owner to check and publish from the claim link. Nothing
 * uploaded here is served until they claim it. The caller rate-limits the token.
 *
 * Inputs (query string or form fields):
 * - title: suggested title
 * - name: suggested name, <root>/<name> (or <name>.<root> on its own host)
 * - ownHost: "true" for a nap on its own host; the default is Nap's frame
 * - kind, slug: the older fields (see napShape)
 * - replaces: claim id (or URL) of an earlier draft; publishing can update what it became
 */
export const handleCreateDraft = Effect.fn("handleCreateDraft")(function* (
  request: Request,
  agent: AgentIdentity,
) {
  yield* rejectLargeBody(request);

  const url = new URL(request.url);
  const parsed = yield* readUpload(request, url, [
    "title",
    "name",
    "slug",
    "kind",
    "ownHost",
    "replaces",
  ]);
  const { files } = parsed;
  const title = parsed.fields.title.slice(0, 120);
  const fields = parsed.fields;
  const shape = napShape({
    kind: fields.kind,
    ownHost: fields.ownHost,
    name: slugify(fields.name),
    slug: slugify(fields.slug),
  });
  if ("error" in shape) return yield* fail(400, shape.error);
  const slug = shape.slug;

  const { totalBytes } = yield* checkFiles(files);

  let replacesDraftId: string | null = null;
  let kind: SiteKind;
  if (fields.replaces) {
    replacesDraftId = parseDraftRef(fields.replaces);
    const replaced = replacesDraftId ? yield* getDraft(replacesDraftId) : null;
    if (!replaced || !isUploader(replaced, agent)) {
      return yield* fail(404, "replaces: draft not found");
    }
    // An update keeps the serving mode of what it updates.
    kind = replaced.kind;
  } else {
    kind = shape.kind;
  }

  const storage = yield* Storage;
  const id = newDraftId();
  for (const file of files) {
    yield* storage.put(draftKey(id, file.path), file.body.stream(), {
      httpMetadata: { contentType: contentTypeForPath(file.path) },
    });
  }

  const db = yield* Database;
  const expiresAt = new Date(Date.now() + DRAFT_TTL_HOURS * 60 * 60 * 1000).toISOString();
  yield* db.batch([
    // Drop metadata for old drafts. An R2 lifecycle rule on `drafts/` removes their files.
    sql("DELETE FROM drafts WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')"),
    sql(
      `INSERT INTO drafts (id, kind, title, slug, replaces_draft_id, file_count, total_bytes,
                           expires_at, created_by_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      kind,
      title,
      slug,
      replacesDraftId,
      files.length,
      totalBytes,
      expiresAt,
      agent.email,
    ),
  ]);

  return json(
    {
      ok: true,
      id,
      kind,
      ownHost: kind === "site",
      claimUrl: `${url.origin}/claim/${id}`,
      expiresAt,
      fileCount: files.length,
      totalBytes,
      message:
        `Draft uploaded. Give the claimUrl to ${agent.email}; only they can open it to publish. ` +
        `To publish a new version later, upload again with replaces=${id}.`,
    },
    { status: 201 },
  );
});

const getDraft = Effect.fnUntraced(function* (id: string) {
  if (!isDraftId(id)) return null;
  const db = yield* Database;
  return yield* db.first<DraftRow>(
    `SELECT id, kind, title, slug, replaces_draft_id AS replacesDraftId,
            file_count AS fileCount, total_bytes AS totalBytes,
            created_at AS createdAt, expires_at AS expiresAt, claimed_at AS claimedAt,
            claimed_by_email AS claimedByEmail, created_by_email AS createdByEmail,
            site_slug AS siteSlug
     FROM drafts WHERE id = ?`,
    id,
  );
});

const getTargetSite = Effect.fnUntraced(function* (slug: string) {
  const db = yield* Database;
  return yield* db.first<TargetSite>(
    `SELECT slug, kind, title, current_version AS currentVersion,
            created_by_email AS createdByEmail, source_repo AS sourceRepo, visibility
     FROM sites WHERE slug = ?`,
    slug,
  );
});

/**
 * Follows `replaces` links back to the first draft that was published, and returns that site.
 * An unpublished draft in the middle of the chain is skipped: its newer draft supersedes it.
 */
const resolveReplacedSite = Effect.fnUntraced(function* (draft: DraftRow) {
  let ref = draft.replacesDraftId;
  for (let step = 0; ref && step < MAX_REPLACES_CHAIN; step++) {
    const previous = yield* getDraft(ref);
    if (!previous) return null;
    if (previous.siteSlug) return yield* getTargetSite(previous.siteSlug);
    ref = previous.replacesDraftId;
  }
  return null;
});

/** The nap this draft would update: from `replaces`, or the nap with its suggested name. */
const findTargetSite = Effect.fnUntraced(function* (draft: DraftRow) {
  const replaced = yield* resolveReplacedSite(draft);
  if (replaced) return replaced;
  if (draft.slug) return yield* getTargetSite(draft.slug);
  return null;
});

/**
 * Anyone who can view a nap may publish a new version of it. Not from a claim link when the nap
 * has a source repo: its versions must come from a pushed commit.
 */
const canUpdate = Effect.fnUntraced(function* (site: TargetSite, identity: Identity) {
  if (site.sourceRepo) return false;
  return yield* canViewSite(site, identity.email);
});

/** GET /api/drafts/:id — what the claim page shows. */
export const describeDraft = Effect.fn("describeDraft")(function* (identity: Identity, id: string) {
  const draft = yield* getDraft(id);
  if (!draft) return yield* fail(404, "Draft not found");
  if (!isUploader(draft, identity)) return yield* fail(403, NOT_YOURS);

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

  const db = yield* Database;
  if (!draft.claimedAt) {
    const site = yield* findTargetSite(draft);
    if (site && (yield* canUpdate(site, identity))) {
      const isOwner = isSameEmail(site.createdByEmail, identity.email);
      const viewers = isOwner
        ? yield* db.all<{ email: string }>(
            "SELECT email FROM site_viewers WHERE site_slug = ? ORDER BY email",
            site.slug,
          )
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
          viewerEmails: viewers.map((row) => row.email),
        }),
      };
    } else if (site && draft.slug) {
      // The suggested name is taken. Say nothing else about a nap they may not see.
      suggestedSite = {
        slug: site.slug,
        kind: site.kind,
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
    : yield* db.first<{ id: string }>(
        "SELECT id FROM drafts WHERE replaces_draft_id = ? ORDER BY created_at DESC LIMIT 1",
        draft.id,
      );

  return json(
    {
      draft: {
        id: draft.id,
        kind: draft.kind,
        ownHost: draft.kind === "site",
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
    { headers: noStore },
  );
});

/**
 * GET /api/drafts/:id/preview/* — serves unclaimed draft files for the claim page iframe.
 * The CSP sandbox gives the document an opaque origin, so draft code cannot act as the
 * signed-in person on the Nap dashboard origin.
 */
export const serveDraftFile = Effect.fn("serveDraftFile")(function* (
  identity: Identity,
  id: string,
  path: string,
) {
  const draft = yield* getDraft(id);
  if (!draft || !isUploader(draft, identity) || draft.claimedAt || isExpired(draft)) {
    return yield* failText(404, "Draft not found");
  }

  const clean = normalizePath(path);
  const filePath = !clean || clean.endsWith("/") ? `${clean}index.html` : clean;
  if (!isSafePath(filePath)) return yield* failText(404, "Not found");

  const object = yield* (yield* Storage).get(draftKey(id, filePath));
  if (!object) return yield* failText(404, "File not found");

  const headers = objectHeaders(object);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-security-policy",
    "sandbox allow-scripts allow-forms allow-popups allow-modals",
  );
  return new Response(object.body, { headers });
});

/**
 * POST /api/drafts/:id — publishes a draft.
 * - replace: true publishes a new version of a nap the person can view. Only the owner may
 *   change its title or who can view it at the same time.
 * - Otherwise it creates a new nap, at a chosen name (`slug`) or else a random id in the frame,
 *   or a name made from the title on its own host.
 */
export const claimDraft = Effect.fn("claimDraft")(function* (
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
  const draft = yield* getDraft(id);
  if (!draft) return yield* fail(404, "Draft not found");
  if (!isUploader(draft, identity)) return yield* fail(403, NOT_YOURS);
  if (draft.claimedAt) return yield* fail(409, "This draft is already published");
  if (isExpired(draft)) return yield* fail(410, "This draft has expired");

  const replace = body.replace === true;
  const requestedSlug = slugify(Predicate.isString(body.slug) ? body.slug : "");
  let requestedTitle = (Predicate.isString(body.title) ? body.title : "").trim().slice(0, 120);
  const expectedCurrentVersion = Predicate.isString(body.expectedCurrentVersion)
    ? body.expectedCurrentVersion
    : null;

  // New naps get the default access. For updates, no visibility means "keep it".
  let visibility: Visibility | null = isVisibility(body.visibility)
    ? body.visibility
    : replace
      ? null
      : DEFAULT_ACCESS;
  const viewerEmails = visibility === "selected" ? normalizeEmails(body.emails) : [];
  if (visibility === "selected" && viewerEmails.length === 0) {
    return yield* fail(400, "Add at least one person");
  }

  yield* ensureProfile(identity);

  let slug: string | null;
  let kind: SiteKind;
  let existing: TargetSite | null = null;
  if (replace) {
    existing = requestedSlug ? yield* getTargetSite(requestedSlug) : null;
    if (!existing || !(yield* canUpdate(existing, identity))) {
      return yield* fail(
        403,
        existing?.sourceRepo
          ? "This nap's source is in a Nap source repo. Ask the agent to push and publish instead."
          : "You can only update naps you can view",
      );
    }
    if (!isSameEmail(existing.createdByEmail, identity.email)) {
      // Only the owner changes who can view it or renames it.
      visibility = null;
      requestedTitle = "";
    }
    if (expectedCurrentVersion && existing.currentVersion !== expectedCurrentVersion) {
      return yield* fail(409, "It changed while you were here. Reload and try again.");
    }
    slug = existing.slug;
    kind = existing.kind;
  } else if (!requestedSlug) {
    // No chosen name: a random id in the frame, or one made from the title on its own host, below.
    slug = null;
    kind = draft.kind;
  } else {
    if (isReservedSlug(requestedSlug)) return yield* fail(409, "That URL is reserved");
    if (yield* getTargetSite(requestedSlug)) return yield* fail(409, "That URL is already taken");
    slug = requestedSlug;
    kind = draft.kind;
  }

  const title = requestedTitle || existing?.title || draft.title || UNTITLED_NAP;
  const isTaken = (candidate: string) => getTargetSite(candidate).pipe(Effect.map(Boolean));
  slug ??=
    kind === "artifact" ? yield* pickArtifactId(isTaken) : yield* pickGeneratedSlug(title, isTaken);
  const target = slug;

  // Take the draft first so two tabs cannot publish it twice.
  const db = yield* Database;
  const taken = yield* db.run(
    `UPDATE drafts SET claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), claimed_by_email = ?
     WHERE id = ? AND claimed_at IS NULL`,
    identity.email,
    id,
  );
  if (taken.changes !== 1) return yield* fail(409, "This draft is already published");

  const release = db.run(
    "UPDATE drafts SET claimed_at = NULL, claimed_by_email = NULL WHERE id = ?",
    id,
  );

  const version = crypto.randomUUID();
  const storage = yield* Storage;
  // Any failure from here on releases the draft, so it can be published again.
  yield* Effect.gen(function* () {
    const copied = yield* copyDraftFiles(id, target, version);
    if (copied.keys.length !== draft.fileCount) {
      return yield* fail(410, "Draft files are missing. Upload again.");
    }

    const versionRow = insertVersion({
      id: version,
      slug: target,
      email: identity.email,
      fileCount: copied.keys.length,
      totalBytes: copied.totalBytes,
      parentVersionId: existing?.currentVersion ?? null,
      source: "claim",
    });
    const draftRow = sql(
      "UPDATE drafts SET site_slug = ?, version_id = ? WHERE id = ?",
      target,
      version,
      id,
    );
    const accessRows = visibility
      ? [
          sql("UPDATE sites SET visibility = ? WHERE slug = ?", visibility, target),
          sql("DELETE FROM site_viewers WHERE site_slug = ?", target),
          ...viewerEmails.map((email) =>
            sql("INSERT INTO site_viewers (site_slug, email) VALUES (?, ?)", target, email),
          ),
        ]
      : [];

    if (existing) {
      const updated = yield* db.run(
        `UPDATE sites
         SET title = ?, updated_by_email = ?, current_version = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE slug = ? AND current_version = ? AND management_type = 'direct'`,
        title,
        identity.email,
        version,
        target,
        existing.currentVersion,
      );
      if (updated.changes !== 1) {
        return yield* fail(409, "It changed while you were here. Reload and try again.");
      }
      yield* db.batch([versionRow, draftRow, ...accessRows]);
    } else {
      const sortOrder = yield* nextSortOrder;
      yield* db.batch([
        sql(
          // Private and unlisted. Naps in the frame get the Nap bar; on their own host it is off.
          `INSERT INTO sites (slug, kind, title, created_by_email, updated_by_email, current_version,
                              sort_order, theme_json, visibility, listed, toolbar)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'private', 0, ?)`,
          target,
          kind,
          title,
          identity.email,
          identity.email,
          version,
          sortOrder,
          JSON.stringify(randomTheme()),
          kind === "artifact" ? 1 : 0,
        ),
        versionRow,
        draftRow,
        ...accessRows,
      ]);
    }

    yield* Effect.ignore(storage.delete(copied.sourceKeys));
  }).pipe(
    Effect.tapCause(() => release),
    Effect.catchIf(
      (error) => error._tag === "DatabaseError" && error.isConstraint,
      () => fail(409, "That URL is already taken"),
    ),
  );

  return json({
    ok: true,
    site: {
      slug: target,
      kind,
      ownHost: kind === "site",
      title,
      currentVersion: version,
      visibility: visibility ?? existing?.visibility,
      replaced: Boolean(existing),
    },
  });
});

const copyDraftFiles = Effect.fnUntraced(function* (id: string, slug: string, version: string) {
  const storage = yield* Storage;
  const prefix = `drafts/${id}/`;
  const keys: Array<string> = [];
  const sourceKeys: Array<string> = [];
  let totalBytes = 0;

  for (const item of yield* storage.list(prefix)) {
    const source = yield* storage.get(item.key);
    if (!source) continue;
    const path = item.key.slice(prefix.length);
    const target = objectKey(slug, version, path);
    yield* storage.put(target, source.body, {
      httpMetadata: { contentType: source.httpMetadata?.contentType ?? contentTypeForPath(path) },
    });
    keys.push(target);
    sourceKeys.push(item.key);
    totalBytes += item.size;
  }

  return { keys, sourceKeys, totalBytes };
});
