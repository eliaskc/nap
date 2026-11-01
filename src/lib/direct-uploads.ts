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
  MAX_DIRECT_UPLOAD_BYTES,
  normalizePath,
  type SiteKind,
} from "~/lib/uploads";
import { Database } from "~/server/database";
import { failNoStore, HttpError, json, noStore } from "~/server/http";
import { Settings } from "~/server/platform";
import { Storage, tryStorage } from "~/server/storage";

/**
 * Direct uploads: large uploads that never pass through the Worker.
 *
 * 1. Start: the client sends the file list (paths and sizes). Nap checks who it is and what it may
 *    publish, picks the URL and a new version id, and returns one presigned PUT URL per file.
 *    Each URL writes exactly one object at sites/<slug>/versions/<version>/<path>, with a fixed
 *    content type and size, and expires after an hour.
 * 2. The client PUTs each file straight to R2.
 * 3. Commit: Nap checks that every file is in R2 with the declared size, records the version,
 *    and makes it live. Until then nothing points at the files. A version id is new, so a URL can
 *    never overwrite a live version.
 *
 * Uncommitted uploads expire. Nap deletes their files when the next upload starts.
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
  filesJson: string;
  fileCount: number;
  totalBytes: number;
  expiresAt: string;
  committedAt: string | null;
  sourceCommit: string | null;
  sourceRepo: string | null;
};

const URL_TTL_SECONDS = 60 * 60;
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
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
  yield* checkManifest(files, MAX_DIRECT_UPLOAD_BYTES);
  return files;
});

export const startDirectUpload = Effect.fn("startDirectUpload")(function* (
  identity: Identity,
  input: StartDirectUploadInput,
) {
  const credentials = (yield* Settings).r2;
  if (!credentials) {
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
  const createdRepo = sourceAccess?.repo ?? null;
  yield* db
    .run(
      `INSERT INTO uploads (id, email, source, client, site_slug, version_id, creates, kind, title,
                            message, owner_only, expected_version, visibility, viewer_emails,
                            files_json, file_count, total_bytes, expires_at, source_commit,
                            source_repo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify(files),
      files.length,
      totalBytes,
      expiresAt,
      sourceCommit,
      createdRepo,
    )
    .pipe(Effect.tapError(() => (createdRepo ? deleteSourceRepo(createdRepo) : Effect.void)));

  const signed = yield* Effect.all(
    files.map((file) =>
      presignPut(credentials, objectKey(target.slug, versionId, file.path), {
        contentType: file.contentType,
        contentLength: file.size,
        expiresInSeconds: URL_TTL_SECONDS,
      }).pipe(
        Effect.map((put) => ({
          path: file.path,
          size: file.size,
          method: "PUT",
          url: put.url,
          headers: put.headers,
        })),
      ),
    ),
    { concurrency: "unbounded" },
  );

  return json(
    {
      uploadId: id,
      id: target.slug,
      kind: target.kind,
      expiresAt,
      files: signed,
      ...(sourceAccess ? { source: sourceAccess } : {}),
    },
    { status: 201, headers: noStore },
  );
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
  const row = yield* db.first<UploadRow>(
    `SELECT id, email, source, client, site_slug AS siteSlug, version_id AS versionId, creates,
            kind, title, message, owner_only AS ownerOnly, expected_version AS expectedVersion,
            visibility, viewer_emails AS viewerEmails, files_json AS filesJson,
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

  // Take the upload first, so two commits cannot both record it.
  const taken = yield* db.run(
    "UPDATE uploads SET committed_at = ? WHERE id = ? AND committed_at IS NULL",
    now(),
    uploadId,
  );
  if (taken.changes !== 1) return yield* failNoStore(409, "This upload is already committed");
  const release = db.run("UPDATE uploads SET committed_at = NULL WHERE id = ?", uploadId);

  const prefix = objectKey(row.siteSlug, row.versionId, "");
  const stored = yield* listSizes(prefix);
  const files = JSON.parse(row.filesJson) as Array<ManifestFile>;
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
  const keys = [...(yield* listSizes(prefix)).keys()].map((path) => prefix + path);
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
