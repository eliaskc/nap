import { Effect, Predicate } from "effect";
import { DEFAULT_ACCESS } from "~/lib/deployment-text";
import { objectKey, type Identity } from "~/lib/nap-server";
import {
  recordVersion,
  resolvePublishTarget,
  titleFromHead,
  type PublishedNap,
  type PublishTarget,
} from "~/lib/publish";
import { presignPut } from "~/lib/r2-presign";
import { isSameEmail, type Visibility } from "~/lib/site-access";
import {
  checkSourceCommit,
  createUploadSource,
  deleteSourceRepo,
  isCommitHash,
  type SourceAccess,
} from "~/lib/sources";
import {
  checkManifest,
  contentTypeForPath,
  MAX_DIRECT_FILE_BYTES,
  MAX_DIRECT_UPLOAD_BYTES,
  MAX_DIRECT_UPLOAD_FILES,
  normalizePath,
  type SiteKind,
} from "~/lib/uploads";
import { Database } from "~/server/database";
import { failNoStore, HttpError } from "~/server/http";
import { Settings } from "~/server/platform";
import { Storage, tryStorage } from "~/server/storage";

/**
 * Direct uploads: large uploads that never pass through the Worker.
 *
 * 1. Start: the client sends the file list (paths and sizes). Nap checks who it is and what it may
 *    publish, picks the URL and a new version id, keeps the list in R2 (the manifest), and
 *    returns presigned PUT URLs for the first page of files. Each URL writes exactly one object at
 *    sites/<slug>/versions/<version>/<path>, with a fixed content type and size, and expires
 *    after an hour.
 * 2. The client PUTs each file straight to R2, and asks for the next page of URLs when it runs
 *    out. Signing is per object (R2 has no upload policy for a whole folder), so Nap signs a
 *    page at a time: a large upload never signs everything in one request, and URLs are fresh
 *    when they are used.
 * 3. Commit: Nap checks that every file in the manifest is in R2 with its size, records the
 *    version, and makes it live. Until then nothing points at the files. A version id is new, so
 *    a URL can never overwrite a live version.
 *
 * The manifest is in R2, not D1: a D1 row holds at most 2 MB, and a list of many thousands of
 * paths does not fit. Uncommitted uploads expire a day after they last signed URLs. Nap
 * deletes their files when the next upload starts.
 *
 * A new site can get its source repo with its first upload (`createSource`). Start creates the
 * repo and returns a write token; the client pushes the commit it built, then commits the upload.
 * Commit checks that the commit is the head of main and gives the site the repo. Until then the
 * upload holds the repo, and an upload that expires deletes it.
 */

export type DirectUploadSource = "dashboard" | "agent";

export type StartDirectUploadInput = {
  files: unknown;
  targetSlug: string | null;
  requireExpectedVersion: boolean;
  expectedCurrentVersion: string | null;
  kind?: SiteKind;
  slug?: string;
  title?: string;
  access?: { visibility: Visibility; emails: Array<string> } | null;
  source: DirectUploadSource;
  client?: string;
  message?: string;
  /** Sites with a source repo: the commit these files were built from. */
  sourceCommit?: string | null;
  /** New sites only: create the source repo with this upload. Needs sourceCommit. */
  createSource?: boolean;
};

type ManifestFile = { path: string; size: number; contentType: string };

type UploadRow = {
  id: string;
  email: string;
  source: DirectUploadSource;
  client: string;
  siteSlug: string;
  versionId: string;
  creates: number;
  kind: SiteKind;
  title: string;
  message: string;
  ownerOnly: number;
  expectedVersion: string | null;
  visibility: Visibility | null;
  viewerEmails: string;
  fileCount: number;
  totalBytes: number;
  expiresAt: string;
  committedAt: string | null;
  sourceCommit: string | null;
  sourceRepo: string | null;
};

export type SignedFile = {
  path: string;
  size: number;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
};

/** One page of presigned URLs. `nextOffset` is where the next page starts, or null at the end. */
export type SignedPage = { files: Array<SignedFile>; nextOffset: number | null; expiresAt: string };

export type StartedDirectUpload = SignedPage & {
  uploadId: string;
  id: string;
  kind: SiteKind;
  fileCount: number;
  totalBytes: number;
  source?: SourceAccess;
};

const URL_TTL_SECONDS = 60 * 60;
/** An upload stays open this long after it last asked for URLs. Large files take a while. */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** Files per page. Signing is CPU work; a page stays well under a second. */
export const SIGNED_PAGE_SIZE = 1_000;
/**
 * Bytes per page, so a page uploads well within the hour its URLs last. A larger file gets a
 * page of its own.
 */
export const SIGNED_PAGE_BYTES = 256 * 1024 * 1024;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const now = () => new Date().toISOString();

/** Reads and checks the file list. A single HTML file becomes index.html, as in other uploads. */
const parseManifest = Effect.fnUntraced(function* (value: unknown) {
  if (!Array.isArray(value)) {
    return yield* failNoStore(400, "files must be a list of { path, size, type }");
  }
  const files: Array<ManifestFile> = [];
  for (const item of value) {
    const entry = (item ?? {}) as { path?: unknown; size?: unknown; type?: unknown };
    if (!Predicate.isString(entry.path) || !Predicate.isNumber(entry.size)) {
      return yield* failNoStore(400, "Each file needs a path (string) and a size (bytes)");
    }
    const path = normalizePath(entry.path);
    const known = contentTypeForPath(path);
    const declared = Predicate.isString(entry.type) ? entry.type.trim().toLowerCase() : "";
    const contentType =
      known === "application/octet-stream" && MIME_TYPE.test(declared) ? declared : known;
    files.push({ path, size: entry.size, contentType });
  }
  if (files.length === 1 && /\.html?$/i.test(files[0].path)) {
    files[0] = { ...files[0], path: "index.html", contentType: contentTypeForPath("index.html") };
  }
  yield* checkManifest(files, {
    maxFiles: MAX_DIRECT_UPLOAD_FILES,
    maxBytes: MAX_DIRECT_UPLOAD_BYTES,
    maxFileBytes: MAX_DIRECT_FILE_BYTES,
  });
  return files;
});

/** The URL of the next page of presigned URLs below an API base, or null after the last page. */
export const nextPageUrl = (base: string, uploadId: string, offset: number | null) =>
  offset === null ? null : `${base}/uploads/${uploadId}/urls?offset=${offset}`;

/** Where an upload keeps its manifest. Outside sites/, so it is never part of a version. */
const manifestKey = (uploadId: string) => `uploads/${uploadId}/manifest.json`;

const readManifest = Effect.fnUntraced(function* (uploadId: string) {
  const object = yield* (yield* Storage).get(manifestKey(uploadId));
  if (!object) return null;
  return JSON.parse(yield* tryStorage(() => object.text())) as Array<ManifestFile>;
});

/** Presigned PUT URLs from `offset`: up to SIGNED_PAGE_SIZE files and SIGNED_PAGE_BYTES. */
const signPage = Effect.fnUntraced(function* (
  files: Array<ManifestFile>,
  offset: number,
  slug: string,
  versionId: string,
) {
  const credentials = (yield* Settings).r2;
  if (!credentials) {
    return yield* failNoStore(503, "Direct uploads are not set up on this Nap", {
      code: "direct_uploads_unavailable",
    });
  }
  let end = offset;
  let bytes = 0;
  while (
    end < files.length &&
    end - offset < SIGNED_PAGE_SIZE &&
    (end === offset || bytes + files[end].size <= SIGNED_PAGE_BYTES)
  ) {
    bytes += files[end].size;
    end++;
  }
  const signed = yield* Effect.all(
    files.slice(offset, end).map((file) =>
      presignPut(credentials, objectKey(slug, versionId, file.path), {
        contentType: file.contentType,
        contentLength: file.size,
        expiresInSeconds: URL_TTL_SECONDS,
      }).pipe(
        Effect.map(
          (put): SignedFile => ({
            path: file.path,
            size: file.size,
            method: "PUT",
            url: put.url,
            headers: put.headers,
          }),
        ),
      ),
    ),
    { concurrency: "unbounded" },
  );
  return { files: signed, nextOffset: end < files.length ? end : null };
});

export const startDirectUpload = Effect.fn("startDirectUpload")(function* (
  identity: Identity,
  input: StartDirectUploadInput,
) {
  if (!(yield* Settings).r2) {
    return yield* failNoStore(503, "Direct uploads are not set up on this Nap", {
      code: "direct_uploads_unavailable",
    });
  }
  yield* cleanupExpiredUploads();

  const files = yield* parseManifest(input.files);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  const target = yield* resolvePublishTarget(
    identity,
    {
      targetSlug: input.targetSlug,
      requireExpectedVersion: input.requireExpectedVersion,
      expectedCurrentVersion: input.expectedCurrentVersion,
      kind: input.kind,
      slug: input.slug,
      title: input.title,
    },
    undefined,
    isHeldByUpload,
  );

  let sourceCommit: string | null = null;
  let sourceAccess: SourceAccess | null = null;
  if (input.createSource) {
    if (target.existing || target.kind !== "site") {
      return yield* failNoStore(
        400,
        target.existing
          ? "createSource is for new sites. The owner adds a repo to an existing site with POST /_nap/api/naps/<id>/source."
          : "Only sites have source repos",
        { code: "create_source_new_sites_only" },
      );
    }
    sourceCommit = (input.sourceCommit ?? "").trim().toLowerCase();
    if (!isCommitHash(sourceCommit)) {
      return yield* failNoStore(
        400,
        "createSource needs sourceCommit: the full commit hash you built and will push",
        { code: "invalid_source_commit" },
      );
    }
    // Nothing is pushed yet. Commit checks the commit.
    sourceAccess = yield* createUploadSource({ slug: target.slug, title: target.title });
  } else {
    // Checked again at commit: main may move while the files upload.
    yield* checkSourceCommit(target.existing, input.sourceCommit);
    sourceCommit = target.existing?.sourceRepo
      ? (input.sourceCommit ?? "").trim().toLowerCase()
      : null;
  }

  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
  const db = yield* Database;
  const storage = yield* Storage;
  const createdRepo = sourceAccess?.repo ?? null;
  const undo = Effect.ignore(storage.delete(manifestKey(id))).pipe(
    Effect.andThen(createdRepo ? deleteSourceRepo(createdRepo) : Effect.void),
  );
  yield* storage
    .put(manifestKey(id), JSON.stringify(files), {
      httpMetadata: { contentType: "application/json" },
    })
    .pipe(Effect.tapError(() => undo));
  yield* db
    .run(
      `INSERT INTO uploads (id, email, source, client, site_slug, version_id, creates, kind, title,
                            message, owner_only, expected_version, visibility, viewer_emails,
                            file_count, total_bytes, expires_at, source_commit, source_repo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      identity.email,
      input.source,
      (input.client ?? "").slice(0, 80),
      target.slug,
      versionId,
      target.existing ? 0 : 1,
      target.kind,
      (input.title ?? "").trim().slice(0, 120),
      (input.message ?? "").trim(),
      // The owner_only column predates shared editing. It now stores requireExpectedVersion.
      input.requireExpectedVersion ? 1 : 0,
      target.existing ? (input.expectedCurrentVersion ?? target.existing.currentVersion) : null,
      target.existing ? null : (input.access?.visibility ?? DEFAULT_ACCESS),
      JSON.stringify(input.access?.visibility === "selected" ? input.access.emails : []),
      files.length,
      totalBytes,
      expiresAt,
      sourceCommit,
      createdRepo,
    )
    .pipe(Effect.tapError(() => undo));

  const page = yield* signPage(files, 0, target.slug, versionId);
  return {
    uploadId: id,
    id: target.slug,
    kind: target.kind,
    fileCount: files.length,
    totalBytes,
    expiresAt,
    ...page,
    ...(sourceAccess ? { source: sourceAccess } : {}),
  } satisfies StartedDirectUpload;
});

/** The open upload, for its owner and the client kind that started it. */
const openUpload = Effect.fnUntraced(function* (
  identity: Identity,
  uploadId: string,
  source: DirectUploadSource,
) {
  const db = yield* Database;
  const row = yield* db.first<UploadRow>(
    `SELECT id, email, source, client, site_slug AS siteSlug, version_id AS versionId, creates,
            kind, title, message, owner_only AS ownerOnly, expected_version AS expectedVersion,
            visibility, viewer_emails AS viewerEmails,
            file_count AS fileCount, total_bytes AS totalBytes, expires_at AS expiresAt,
            committed_at AS committedAt, source_commit AS sourceCommit,
            source_repo AS sourceRepo
     FROM uploads WHERE id = ?`,
    uploadId,
  );
  if (!row || !isSameEmail(row.email, identity.email) || row.source !== source) {
    return yield* failNoStore(404, "Upload not found");
  }
  if (row.committedAt) return yield* failNoStore(409, "This upload is already committed");
  if (row.expiresAt < now())
    return yield* failNoStore(410, "This upload has expired. Start again.");
  return row;
});

/**
 * The next page of URLs, from `offset` in the manifest. Asking for a page keeps the upload open
 * for another day, so a large upload does not expire while it runs.
 */
export const signDirectUploadPage = Effect.fn("signDirectUploadPage")(function* (
  identity: Identity,
  uploadId: string,
  source: DirectUploadSource,
  offset: number,
) {
  const row = yield* openUpload(identity, uploadId, source);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= row.fileCount) {
    return yield* failNoStore(400, `offset must be a whole number from 0 to ${row.fileCount - 1}`);
  }
  const files = yield* readManifest(row.id);
  if (!files) return yield* failNoStore(410, "This upload has expired. Start again.");
  const page = yield* signPage(files, offset, row.siteSlug, row.versionId);
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
  yield* (yield* Database).run(
    "UPDATE uploads SET expires_at = ? WHERE id = ? AND committed_at IS NULL",
    expiresAt,
    row.id,
  );
  return { ...page, expiresAt } satisfies SignedPage;
});

const isHttpError = (error: unknown): error is HttpError => error instanceof HttpError;

/**
 * Checks the files in R2 and makes the version live. If files are missing, the upload stays
 * open: PUT them again and commit again. Any other refusal deletes the upload and its files.
 */
export const commitDirectUpload = Effect.fn("commitDirectUpload")(function* (
  identity: Identity,
  uploadId: string,
  source: DirectUploadSource,
) {
  const db = yield* Database;
  const row = yield* openUpload(identity, uploadId, source);

  // Take the upload first, so two commits cannot both record it.
  const taken = yield* db.run(
    "UPDATE uploads SET committed_at = ? WHERE id = ? AND committed_at IS NULL",
    now(),
    uploadId,
  );
  if (taken.changes !== 1) return yield* failNoStore(409, "This upload is already committed");
  const release = db.run("UPDATE uploads SET committed_at = NULL WHERE id = ?", uploadId);

  const prefix = objectKey(row.siteSlug, row.versionId, "");
  const files = yield* readManifest(row.id);
  if (!files) {
    yield* deleteUpload(row.id, prefix, row.sourceRepo);
    return yield* failNoStore(410, "This upload has expired. Start again.");
  }
  const stored = yield* listSizes(prefix);
  const problems = files.filter((file) => stored.get(file.path) !== file.size);
  if (problems.length > 0) {
    yield* release;
    return yield* failNoStore(
      409,
      `${problems.length} of ${files.length} files are missing or have the wrong size. Upload them again, then commit again.`,
      { code: "files_missing", missing: problems.slice(0, 50).map((file) => file.path) },
    );
  }

  const storage = yield* Storage;
  const pageTitle = Effect.gen(function* () {
    const object = yield* storage.get(`${prefix}index.html`, {
      range: { offset: 0, length: 64 * 1024 },
    });
    return object ? titleFromHead(yield* tryStorage(() => object.text())) : "";
  });

  let created: PublishTarget | null = null;
  if (row.creates) {
    const title =
      row.title ||
      (yield* pageTitle) ||
      (row.kind === "artifact" ? "Untitled artifact" : "Untitled site");
    created = { slug: row.siteSlug, kind: row.kind, title, existing: null };
    if (row.sourceRepo) {
      yield* checkSourceCommit(
        { slug: row.siteSlug, sourceRepo: row.sourceRepo, currentVersion: null },
        row.sourceCommit,
      ).pipe(
        // Usually the push has not landed yet. Keep the upload and its repo: push, then commit
        // again.
        Effect.tapError((error) => (isHttpError(error) ? release : Effect.void)),
      );
    }
  }

  const publish = Effect.gen(function* () {
    let target: PublishTarget;
    if (created) {
      target = created;
    } else {
      target = yield* resolvePublishTarget(
        identity,
        {
          targetSlug: row.siteSlug,
          requireExpectedVersion: Boolean(row.ownerOnly),
          expectedCurrentVersion: row.expectedVersion,
          title: row.title,
        },
        pageTitle,
      );
      yield* checkSourceCommit(target.existing, row.sourceCommit);
    }
    return yield* recordVersion(identity, target, {
      version: row.versionId,
      fileCount: row.fileCount,
      totalBytes: row.totalBytes,
      access: row.visibility
        ? { visibility: row.visibility, emails: JSON.parse(row.viewerEmails) as Array<string> }
        : undefined,
      source: row.source,
      client: row.client,
      message: row.message,
      sourceCommit: row.sourceCommit,
      sourceRepo: row.sourceRepo,
    });
  });
  const published: PublishedNap = yield* publish.pipe(
    // Refused: the version can never go live. Drop its files, and the repo it would have created.
    Effect.tapError((error) =>
      isHttpError(error) ? deleteUpload(row.id, prefix, row.sourceRepo) : Effect.void,
    ),
  );
  yield* Effect.ignore(storage.delete(manifestKey(row.id)));
  return published;
});

/** A new nap's URL is held by an open upload until it expires. */
const isHeldByUpload = Effect.fnUntraced(function* (slug: string) {
  const db = yield* Database;
  const held = yield* db.first(
    `SELECT 1 FROM uploads
     WHERE site_slug = ? AND creates = 1 AND committed_at IS NULL AND expires_at > ?`,
    slug,
    now(),
  );
  return Boolean(held);
});

const listSizes = Effect.fnUntraced(function* (prefix: string) {
  const sizes = new Map<string, number>();
  for (const item of yield* (yield* Storage).list(prefix)) {
    sizes.set(item.key.slice(prefix.length), item.size);
  }
  return sizes;
});

const deleteUpload = Effect.fnUntraced(function* (
  id: string,
  prefix: string,
  sourceRepo: string | null,
) {
  if (sourceRepo) yield* deleteSourceRepo(sourceRepo);
  const storage = yield* Storage;
  const keys = [manifestKey(id), ...[...(yield* listSizes(prefix)).keys()].map((p) => prefix + p)];
  for (let start = 0; start < keys.length; start += 1000) {
    yield* storage.delete(keys.slice(start, start + 1000));
  }
  const db = yield* Database;
  yield* db.run("DELETE FROM uploads WHERE id = ?", id);
});

/** Deletes a few expired uploads and their files. Runs when an upload starts. */
const cleanupExpiredUploads = Effect.fnUntraced(function* () {
  const db = yield* Database;
  const expired = yield* db.all<{
    id: string;
    siteSlug: string;
    versionId: string;
    sourceRepo: string | null;
  }>(
    `SELECT id, site_slug AS siteSlug, version_id AS versionId, source_repo AS sourceRepo
     FROM uploads WHERE committed_at IS NULL AND expires_at < ? LIMIT 5`,
    now(),
  );
  for (const upload of expired) {
    yield* deleteUpload(
      upload.id,
      objectKey(upload.siteSlug, upload.versionId, ""),
      upload.sourceRepo,
    );
  }
  yield* db.run(
    "DELETE FROM uploads WHERE committed_at IS NOT NULL AND committed_at < ?",
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  );
});
