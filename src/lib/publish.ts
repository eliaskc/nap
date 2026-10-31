import { DEFAULT_ACCESS } from "~/lib/deployment-text";
import { json, objectKey, type Identity } from "~/lib/nap-server";
import { canViewSite, isSameEmail, type Visibility } from "~/lib/site-access";
import {
  checkFiles,
  contentTypeForPath,
  isReservedSlug,
  pickArtifactId,
  pickGeneratedSlug,
  nextSortOrder,
  randomTheme,
  type IncomingFile,
  type SiteKind,
} from "~/lib/uploads";
import { checkSourceCommit } from "~/lib/sources";
import { insertVersion, type VersionSource } from "~/lib/versions";

type PublishEnv = { DB: D1Database; SITES: R2Bucket; SOURCES?: unknown };

export type PublishInput = PublishTargetInput & {
  files: Array<IncomingFile>;
  /** New naps only. Without it, a new nap is private. Updates never change access. */
  access?: { visibility: Visibility; emails: Array<string> };
  source: VersionSource;
  client?: string;
  message?: string;
  /** Sites with a source repo: the commit these files were built from. */
  sourceCommit?: string | null;
};

export type PublishedNap = {
  slug: string;
  kind: SiteKind;
  title: string;
  currentVersion: string;
  previousVersion: string | null;
  created: boolean;
  /** Who can view it. */
  visibility: Visibility;
};

export type ExistingNap = {
  slug: string;
  kind: SiteKind;
  title: string;
  currentVersion: string;
  sourceRepo: string | null;
  createdByEmail: string;
  visibility: Visibility;
};

function getNap(db: D1Database, slug: string) {
  return db
    .prepare(
      `SELECT slug, kind, title, current_version AS currentVersion,
              source_repo AS sourceRepo, created_by_email AS createdByEmail, visibility
       FROM sites WHERE slug = ?`,
    )
    .bind(slug)
    .first<ExistingNap>();
}

const changedMeanwhile = () =>
  json(
    { error: "It was updated while you were uploading. Reload and try again." },
    { status: 409 },
  );

export type PublishTargetInput = {
  /** Publish a new version of this nap. Without it, create a new nap. */
  targetSlug?: string | null;
  /**
   * Anyone who can view a nap may publish a new version of it. With this set, someone other than
   * the owner must also send `expectedCurrentVersion`, so an agent cannot overwrite a nap it has
   * not read first.
   */
  requireExpectedVersion?: boolean;
  /** Refuse the update if the live version is no longer this one. */
  expectedCurrentVersion?: string | null;
  /** New naps only. */
  kind?: SiteKind;
  /** New sites only: a chosen URL. Without it, Nap makes one from the title. Artifacts get a random id. */
  slug?: string;
  title?: string;
};

export type PublishTarget = {
  slug: string;
  kind: SiteKind;
  title: string;
  existing: ExistingNap | null;
};

/**
 * Checks what the person may publish to, and picks the URL for a new nap. `pageTitle` gives the
 * page's own title when no title was sent. `isReserved` reports URLs that another upload holds.
 */
export async function resolvePublishTarget(
  db: D1Database,
  identity: Identity,
  input: PublishTargetInput,
  pageTitle: () => Promise<string> = async () => "",
  isReserved: (slug: string) => Promise<boolean> = async () => false,
): Promise<Response | PublishTarget> {
  let slug: string | null = null;
  let existing: ExistingNap | null = null;
  if (input.targetSlug) {
    existing = await getNap(db, input.targetSlug);
    if (!existing || !(await canViewSite(db, existing, identity.email))) {
      return json({ error: "Not found" }, { status: 404 });
    }
    const isOwner = isSameEmail(existing.createdByEmail, identity.email);
    if (input.requireExpectedVersion && !isOwner && !input.expectedCurrentVersion) {
      return json(
        {
          error: `This nap belongs to ${existing.createdByEmail}. Read it first, then send its currentVersion as expectedVersion so you don't overwrite someone else's change.`,
          code: "expected_version_required",
        },
        { status: 409 },
      );
    }
    // Only the owner renames. Others publish under the current name.
    if (!isOwner) input = { ...input, title: "" };
    if (input.expectedCurrentVersion && existing.currentVersion !== input.expectedCurrentVersion) {
      return changedMeanwhile();
    }
    slug = existing.slug;
  } else if (input.slug && input.kind !== "artifact") {
    if (isReservedSlug(input.slug)) return json({ error: "That URL is reserved" }, { status: 409 });
    const taken = await getNap(db, input.slug);
    if (taken || (await isReserved(input.slug))) {
      return json({ error: "That URL is already taken" }, { status: 409 });
    }
    slug = input.slug;
  }

  const kind: SiteKind = existing?.kind ?? input.kind ?? "site";
  const title =
    input.title?.trim().slice(0, 120) ||
    existing?.title ||
    (await pageTitle()) ||
    (kind === "artifact" ? "Untitled artifact" : "Untitled site");
  // Artifacts get a random id. Sites without a chosen URL get one made from the title.
  const isTaken = async (candidate: string) =>
    Boolean(await getNap(db, candidate)) || (await isReserved(candidate));
  slug ??=
    kind === "artifact" ? await pickArtifactId(isTaken) : await pickGeneratedSlug(title, isTaken);
  return { slug, kind, title, existing };
}

/**
 * Stores the files as a new immutable version and makes it live. New naps are unlisted and
 * private unless `access` says otherwise; artifacts get the Nap toolbar. The caller checks who
 * the person is; this checks what they may change.
 */
export async function publishFiles(
  env: PublishEnv,
  identity: Identity,
  input: PublishInput,
): Promise<Response | PublishedNap> {
  const checked = checkFiles(input.files);
  if (checked instanceof Response) return checked;

  const target = await resolvePublishTarget(env.DB, identity, input, () =>
    titleFromHtml(input.files.find((file) => file.path === "index.html")?.body),
  );
  if (target instanceof Response) return target;
  const sourceProblem = await checkSourceCommit(env, target.existing, input.sourceCommit);
  if (sourceProblem) return sourceProblem;

  const version = crypto.randomUUID();
  for (const file of input.files) {
    const known = contentTypeForPath(file.path);
    await env.SITES.put(objectKey(target.slug, version, file.path), file.body.stream(), {
      httpMetadata: {
        contentType:
          known === "application/octet-stream" && file.body.type ? file.body.type : known,
      },
    });
  }

  return recordVersion(env.DB, identity, target, {
    version,
    fileCount: input.files.length,
    totalBytes: checked.totalBytes,
    access: input.access,
    source: input.source,
    client: input.client,
    message: input.message,
    sourceCommit: input.sourceCommit,
  });
}

/**
 * Records a version whose files are already in R2 under objectKey(target.slug, version, ...),
 * and makes it live. Updates move the live pointer only if it has not moved since `target` was
 * read. New naps get the given access, or stay private.
 */
export async function recordVersion(
  db: D1Database,
  identity: Identity,
  target: PublishTarget,
  input: {
    version: string;
    fileCount: number;
    totalBytes: number;
    access?: { visibility: Visibility; emails: Array<string> };
    source: VersionSource;
    client?: string;
    message?: string;
    sourceCommit?: string | null;
    /** New sites only: the source repo created with the first upload. */
    sourceRepo?: string | null;
  },
): Promise<Response | PublishedNap> {
  const { slug, kind, title, existing } = target;
  const { version } = input;
  const sourceRepo = existing ? existing.sourceRepo : (input.sourceRepo ?? null);
  const versionRow = insertVersion(db, {
    id: version,
    slug,
    email: identity.email,
    fileCount: input.fileCount,
    totalBytes: input.totalBytes,
    parentVersionId: existing?.currentVersion ?? null,
    source: input.source,
    client: input.client,
    message: input.message,
    sourceCommit: sourceRepo ? input.sourceCommit?.trim().toLowerCase() : null,
  });

  let visibility: Visibility = existing?.visibility ?? DEFAULT_ACCESS;
  if (existing) {
    const [, updated] = await db.batch([
      versionRow,
      db
        .prepare(
          `UPDATE sites
           SET title = ?, updated_by_email = ?, current_version = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE slug = ? AND current_version = ? AND management_type = 'direct'`,
        )
        .bind(title, identity.email, version, slug, existing.currentVersion),
    ]);
    if (updated.meta.changes !== 1) {
      // Another upload won. Keep the history true: this version never went live.
      await db.prepare("DELETE FROM versions WHERE id = ?").bind(version).run();
      return changedMeanwhile();
    }
  } else {
    const access = input.access ?? { visibility: DEFAULT_ACCESS, emails: [] };
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO sites (slug, kind, title, created_by_email, updated_by_email, current_version,
                                sort_order, theme_json, visibility, listed, toolbar, source_repo)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .bind(
            slug,
            kind,
            title,
            identity.email,
            identity.email,
            version,
            await nextSortOrder(db),
            JSON.stringify(randomTheme()),
            access.visibility,
            kind === "artifact" ? 1 : 0,
            sourceRepo,
          ),
        versionRow,
        ...(access.visibility === "selected" ? access.emails : []).map((email) =>
          db.prepare("INSERT INTO site_viewers (site_slug, email) VALUES (?, ?)").bind(slug, email),
        ),
      ]);
    } catch (error) {
      if (/UNIQUE|PRIMARY KEY/i.test(String(error))) {
        return json({ error: "That URL is already taken" }, { status: 409 });
      }
      throw error;
    }
    visibility = access.visibility;
  }

  return {
    slug,
    kind,
    title,
    currentVersion: version,
    previousVersion: existing?.currentVersion ?? null,
    created: !existing,
    visibility,
  };
}

/** The page's <title>, from the first 64 KB of index.html. */
export async function titleFromHtml(file: Blob | undefined) {
  if (!file) return "";
  return titleFromHead(await file.slice(0, 64 * 1024).text());
}

/** The <title> in the start of an HTML page. */
export function titleFromHead(head: string) {
  const match = head.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!match) return "";
  return decodeEntities(match[1]).replace(/\s+/g, " ").trim().slice(0, 120);
}

function decodeEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
