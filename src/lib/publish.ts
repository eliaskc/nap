import { Effect } from "effect";
import { DEFAULT_ACCESS } from "~/lib/deployment-text";
import { objectKey, type Identity } from "~/lib/nap-server";
import { canViewSite, isSameEmail, type Visibility } from "~/lib/site-access";
import {
  checkFiles,
  contentTypeForPath,
  isReservedSlug,
  pickArtifactId,
  pickGeneratedSlug,
  nextSortOrder,
  randomTheme,
  UNTITLED_NAP,
  type IncomingFile,
  type SiteKind,
} from "~/lib/uploads";
import { DEFAULT_NAP_TYPE, type NapType } from "~/lib/nap-types";
import { checkSourceCommit } from "~/lib/sources";
import { insertVersion, type VersionSource } from "~/lib/versions";
import { Database, sql } from "~/server/database";
import { fail } from "~/server/http";
import { Storage, tryStorage } from "~/server/storage";

export type PublishInput = PublishTargetInput & {
  files: Array<IncomingFile>;
  /** New naps only. Without it, a new nap is private. Updates never change access. */
  access?: { visibility: Visibility; emails: Array<string> };
  source: VersionSource;
  client?: string;
  message?: string;
  /** Naps with a source repo: the commit these files were built from. */
  sourceCommit?: string | null;
};

export type PublishedNap = {
  slug: string;
  kind: SiteKind;
  type: NapType;
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
  type: NapType;
  title: string;
  currentVersion: string;
  sourceRepo: string | null;
  createdByEmail: string;
  visibility: Visibility;
};

const getNap = Effect.fnUntraced(function* (slug: string) {
  const db = yield* Database;
  return yield* db.first<ExistingNap>(
    `SELECT slug, kind, type, title, current_version AS currentVersion,
            source_repo AS sourceRepo, created_by_email AS createdByEmail, visibility
     FROM sites WHERE slug = ?`,
    slug,
  );
});

const changedMeanwhile = () =>
  fail(409, "It was updated while you were uploading. Reload and try again.");

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
  /** New naps only: how it is served. */
  kind?: SiteKind;
  /**
   * New naps only: a chosen name. Without it, a nap in the frame gets a random id, and one on its
   * own host a name made from the title.
   */
  slug?: string;
  title?: string;
  /**
   * The nap's type (nap-types.ts). New naps without one are pages. On an update only the owner
   * changes it; without one, or from anyone else, it stays.
   */
  type?: NapType;
};

export type PublishTarget = {
  slug: string;
  kind: SiteKind;
  /** A new nap's type, or an update's new type. Null: an update keeps the type it has. */
  type: NapType | null;
  title: string;
  existing: ExistingNap | null;
};

/**
 * Checks what the person may publish to, and picks the URL for a new nap. `pageTitle` gives the
 * page's own title when no title was sent. `isReserved` reports URLs that another upload holds.
 */
export const resolvePublishTarget = Effect.fn("resolvePublishTarget")(function* <
  E1 = never,
  R1 = never,
  E2 = never,
  R2 = never,
>(
  identity: Identity,
  input: PublishTargetInput,
  pageTitle: Effect.Effect<string, E1, R1> = Effect.succeed("") as Effect.Effect<string, E1, R1>,
  isReserved: (slug: string) => Effect.Effect<boolean, E2, R2> = () =>
    Effect.succeed(false) as Effect.Effect<boolean, E2, R2>,
) {
  let slug: string | null = null;
  let existing: ExistingNap | null = null;
  if (input.targetSlug) {
    existing = yield* getNap(input.targetSlug);
    if (!existing || !(yield* canViewSite(existing, identity.email))) {
      return yield* fail(404, "Not found");
    }
    const isOwner = isSameEmail(existing.createdByEmail, identity.email);
    if (input.requireExpectedVersion && !isOwner && !input.expectedCurrentVersion) {
      return yield* fail(
        409,
        `This nap belongs to ${existing.createdByEmail}. Read it first, then send its currentVersion as expectedVersion so you don't overwrite someone else's change.`,
        { code: "expected_version_required" },
      );
    }
    // Only the owner renames or changes the type. Others publish under the current ones.
    if (!isOwner) input = { ...input, title: "", type: undefined };
    if (input.expectedCurrentVersion && existing.currentVersion !== input.expectedCurrentVersion) {
      return yield* changedMeanwhile();
    }
    slug = existing.slug;
  } else if (input.slug) {
    if (isReservedSlug(input.slug)) return yield* fail(409, "That URL is reserved");
    const taken = yield* getNap(input.slug);
    if (taken || (yield* isReserved(input.slug))) {
      return yield* fail(409, "That URL is already taken");
    }
    slug = input.slug;
  }

  const kind: SiteKind = existing?.kind ?? input.kind ?? "site";
  const title =
    input.title?.trim().slice(0, 120) || existing?.title || (yield* pageTitle) || UNTITLED_NAP;
  // Without a chosen name: a random id in the frame, one made from the title on its own host.
  const isTaken = (candidate: string) =>
    Effect.gen(function* () {
      return Boolean(yield* getNap(candidate)) || (yield* isReserved(candidate));
    });
  slug ??=
    kind === "artifact" ? yield* pickArtifactId(isTaken) : yield* pickGeneratedSlug(title, isTaken);
  const type = existing ? (input.type ?? null) : (input.type ?? DEFAULT_NAP_TYPE);
  return { slug, kind, type, title, existing } satisfies PublishTarget;
});

/**
 * Stores the files as a new immutable version and makes it live. New naps are unlisted and
 * private unless `access` says otherwise; naps in the frame get the Nap bar. The caller checks who
 * the person is; this checks what they may change.
 */
export const publishFiles = Effect.fn("publishFiles")(function* (
  identity: Identity,
  input: PublishInput,
) {
  const checked = yield* checkFiles(input.files);

  const target = yield* resolvePublishTarget(
    identity,
    input,
    titleFromHtml(input.files.find((file) => file.path === "index.html")?.body),
  );
  yield* checkSourceCommit(target.existing, input.sourceCommit);

  const storage = yield* Storage;
  const version = crypto.randomUUID();
  for (const file of input.files) {
    const known = contentTypeForPath(file.path);
    yield* storage.put(objectKey(target.slug, version, file.path), file.body.stream(), {
      httpMetadata: {
        contentType:
          known === "application/octet-stream" && file.body.type ? file.body.type : known,
      },
    });
  }

  return yield* recordVersion(identity, target, {
    version,
    fileCount: input.files.length,
    totalBytes: checked.totalBytes,
    access: input.access,
    source: input.source,
    client: input.client,
    message: input.message,
    sourceCommit: input.sourceCommit,
  });
});

/**
 * Records a version whose files are already in R2 under objectKey(target.slug, version, ...),
 * and makes it live. Updates move the live pointer only if it has not moved since `target` was
 * read. New naps get the given access, or stay private.
 */
export const recordVersion = Effect.fn("recordVersion")(function* (
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
    /** New naps only: the source repo created with the first upload. */
    sourceRepo?: string | null;
  },
) {
  const db = yield* Database;
  const { slug, kind, title, existing } = target;
  const type: NapType = target.type ?? existing?.type ?? DEFAULT_NAP_TYPE;
  const { version } = input;
  const sourceRepo = existing ? existing.sourceRepo : (input.sourceRepo ?? null);
  const versionRow = insertVersion({
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
    const [, updated] = yield* db.batch([
      versionRow,
      sql(
        `UPDATE sites
         SET title = ?, type = COALESCE(?, type), updated_by_email = ?, current_version = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE slug = ? AND current_version = ? AND management_type = 'direct'`,
        title,
        target.type,
        identity.email,
        version,
        slug,
        existing.currentVersion,
      ),
    ]);
    if (updated.changes !== 1) {
      // Another upload won. Keep the history true: this version never went live.
      yield* db.run("DELETE FROM versions WHERE id = ?", version);
      return yield* changedMeanwhile();
    }
  } else {
    const access = input.access ?? { visibility: DEFAULT_ACCESS, emails: [] };
    const sortOrder = yield* nextSortOrder;
    yield* db
      .batch([
        sql(
          `INSERT INTO sites (slug, kind, type, title, created_by_email, updated_by_email,
                              current_version, sort_order, theme_json, visibility, listed, toolbar,
                              source_repo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          slug,
          kind,
          type,
          title,
          identity.email,
          identity.email,
          version,
          sortOrder,
          JSON.stringify(randomTheme()),
          access.visibility,
          kind === "artifact" ? 1 : 0,
          sourceRepo,
        ),
        versionRow,
        ...(access.visibility === "selected" ? access.emails : []).map((email) =>
          sql("INSERT INTO site_viewers (site_slug, email) VALUES (?, ?)", slug, email),
        ),
      ])
      .pipe(
        Effect.catchIf(
          (error) => error.isConstraint,
          () => fail(409, "That URL is already taken"),
        ),
      );
    visibility = access.visibility;
  }

  return {
    slug,
    kind,
    type,
    title,
    currentVersion: version,
    previousVersion: existing?.currentVersion ?? null,
    created: !existing,
    visibility,
  } satisfies PublishedNap;
});

/** The page's <title>, from the first 64 KB of index.html. */
export const titleFromHtml = (file: Blob | undefined) =>
  file
    ? tryStorage(() => file.slice(0, 64 * 1024).text()).pipe(Effect.map(titleFromHead))
    : Effect.succeed("");

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
