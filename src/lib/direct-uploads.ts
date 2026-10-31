import { DEFAULT_ACCESS } from "~/lib/deployment-text";
import { json, objectKey, type Identity } from "~/lib/nap-server";
import {
  recordVersion,
  resolvePublishTarget,
  titleFromHead,
  type PublishedNap,
  type PublishTarget,
} from "~/lib/publish";
import { presignPut, type R2Credentials } from "~/lib/r2-presign";
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

export type DirectUploadEnv = {
  DB: D1Database;
  SITES: R2Bucket;
  NAP_R2_ACCOUNT_ID?: string;
  NAP_R2_BUCKET?: string;
  NAP_R2_ACCESS_KEY_ID?: string;
  NAP_R2_SECRET_ACCESS_KEY?: string;
  SOURCES?: unknown;
};

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

export function directUploadCredentials(env: DirectUploadEnv): R2Credentials | null {
  const { NAP_R2_ACCOUNT_ID, NAP_R2_BUCKET, NAP_R2_ACCESS_KEY_ID, NAP_R2_SECRET_ACCESS_KEY } = env;
  if (!NAP_R2_ACCOUNT_ID || !NAP_R2_BUCKET || !NAP_R2_ACCESS_KEY_ID || !NAP_R2_SECRET_ACCESS_KEY) {
    return null;
  }
  return {
    accountId: NAP_R2_ACCOUNT_ID,
    bucket: NAP_R2_BUCKET,
    accessKeyId: NAP_R2_ACCESS_KEY_ID,
    secretAccessKey: NAP_R2_SECRET_ACCESS_KEY,
  };
}

/** Reads and checks the file list. A single HTML file becomes index.html, as in other uploads. */
function parseManifest(value: unknown): Response | Array<ManifestFile> {
  if (!Array.isArray(value)) {
    return json(
      { error: "files must be a list of { path, size, type }" },
      { status: 400, headers: noStore },
    );
  }
  const files: Array<ManifestFile> = [];
  for (const item of value) {
    const entry = (item ?? {}) as { path?: unknown; size?: unknown; type?: unknown };
    if (typeof entry.path !== "string" || typeof entry.size !== "number") {
      return json(
        { error: "Each file needs a path (string) and a size (bytes)" },
        { status: 400, headers: noStore },
      );
    }
    const path = normalizePath(entry.path);
    const known = contentTypeForPath(path);
    const declared = typeof entry.type === "string" ? entry.type.trim().toLowerCase() : "";
    const contentType =
      known === "application/octet-stream" && MIME_TYPE.test(declared) ? declared : known;
    files.push({ path, size: entry.size, contentType });
  }
  if (files.length === 1 && /\.html?$/i.test(files[0].path)) {
    files[0] = { ...files[0], path: "index.html", contentType: contentTypeForPath("index.html") };
  }
  const checked = checkManifest(files, MAX_DIRECT_UPLOAD_BYTES);
  return checked instanceof Response ? checked : files;
}

export async function startDirectUpload(
  env: DirectUploadEnv,
  identity: Identity,
  input: StartDirectUploadInput,
): Promise<Response> {
  const credentials = directUploadCredentials(env);
  if (!credentials) {
    return json(
      { error: "Direct uploads are not set up on this Nap", code: "direct_uploads_unavailable" },
      { status: 503, headers: noStore },
    );
  }
  await cleanupExpiredUploads(env);

  const files = parseManifest(input.files);
  if (files instanceof Response) return files;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  const target = await resolvePublishTarget(
    env.DB,
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
    (slug) => isHeldByUpload(env.DB, slug),
  );
  if (target instanceof Response) return target;

  let sourceCommit: string | null = null;
  let sourceAccess: SourceAccess | null = null;
  if (input.createSource) {
    if (target.existing || target.kind !== "site") {
      return json(
        {
          error: target.existing
            ? "createSource is for new sites. The owner adds a repo to an existing site with POST /_nap/api/naps/<id>/source."
            : "Only sites have source repos",
          code: "create_source_new_sites_only",
        },
        { status: 400, headers: noStore },
      );
    }
    sourceCommit = (input.sourceCommit ?? "").trim().toLowerCase();
    if (!isCommitHash(sourceCommit)) {
      return json(
        {
          error: "createSource needs sourceCommit: the full commit hash you built and will push",
          code: "invalid_source_commit",
        },
        { status: 400, headers: noStore },
      );
    }
    // Nothing is pushed yet. Commit checks the commit.
    const created = await createUploadSource(env, { slug: target.slug, title: target.title });
    if (created instanceof Response) return created;
    sourceAccess = created;
  } else {
    // Checked again at commit: main may move while the files upload.
    const sourceProblem = await checkSourceCommit(env, target.existing, input.sourceCommit);
    if (sourceProblem) return sourceProblem;
    sourceCommit = target.existing?.sourceRepo
      ? (input.sourceCommit ?? "").trim().toLowerCase()
      : null;
  }

  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO uploads (id, email, source, client, site_slug, version_id, creates, kind, title,
                          message, owner_only, expected_version, visibility, viewer_emails,
                          files_json, file_count, total_bytes, expires_at, source_commit,
                          source_repo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
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
      sourceAccess?.repo ?? null,
    )
    .run()
    .catch(async (error) => {
      if (sourceAccess) await deleteSourceRepo(env, sourceAccess.repo);
      throw error;
    });

  const signed = await Promise.all(
    files.map(async (file) => {
      const put = await presignPut(credentials, objectKey(target.slug, versionId, file.path), {
        contentType: file.contentType,
        contentLength: file.size,
        expiresInSeconds: URL_TTL_SECONDS,
      });
      return {
        path: file.path,
        size: file.size,
        method: "PUT",
        url: put.url,
        headers: put.headers,
      };
    }),
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
}

/**
 * Checks the files in R2 and makes the version live. If files are missing, the upload stays
 * open: PUT them again and commit again. Any other failure deletes the upload and its files.
 */
export async function commitDirectUpload(
  env: DirectUploadEnv,
  identity: Identity,
  uploadId: string,
  source: DirectUploadSource,
): Promise<Response | PublishedNap> {
  const row = await env.DB.prepare(
    `SELECT id, email, source, client, site_slug AS siteSlug, version_id AS versionId, creates,
            kind, title, message, owner_only AS ownerOnly, expected_version AS expectedVersion,
            visibility, viewer_emails AS viewerEmails, files_json AS filesJson,
            file_count AS fileCount, total_bytes AS totalBytes, expires_at AS expiresAt,
            committed_at AS committedAt, source_commit AS sourceCommit,
            source_repo AS sourceRepo
     FROM uploads WHERE id = ?`,
  )
    .bind(uploadId)
    .first<UploadRow>();
  if (!row || !isSameEmail(row.email, identity.email) || row.source !== source) {
    return json({ error: "Upload not found" }, { status: 404, headers: noStore });
  }
  if (row.committedAt) {
    return json({ error: "This upload is already committed" }, { status: 409, headers: noStore });
  }
  if (row.expiresAt < now()) {
    return json(
      { error: "This upload has expired. Start again." },
      { status: 410, headers: noStore },
    );
  }

  // Take the upload first, so two commits cannot both record it.
  const taken = await env.DB.prepare(
    "UPDATE uploads SET committed_at = ? WHERE id = ? AND committed_at IS NULL",
  )
    .bind(now(), uploadId)
    .run();
  if (taken.meta.changes !== 1) {
    return json({ error: "This upload is already committed" }, { status: 409, headers: noStore });
  }
  const release = () =>
    env.DB.prepare("UPDATE uploads SET committed_at = NULL WHERE id = ?").bind(uploadId).run();

  const prefix = objectKey(row.siteSlug, row.versionId, "");
  const stored = await listSizes(env.SITES, prefix);
  const files = JSON.parse(row.filesJson) as Array<ManifestFile>;
  const problems = files.filter((file) => stored.get(file.path) !== file.size);
  if (problems.length > 0) {
    await release();
    return json(
      {
        error: `${problems.length} of ${files.length} files are missing or have the wrong size. Upload them again, then commit again.`,
        code: "files_missing",
        missing: problems.slice(0, 50).map((file) => file.path),
      },
      { status: 409, headers: noStore },
    );
  }

  const pageTitle = async () => {
    const object = await env.SITES.get(`${prefix}index.html`, {
      range: { offset: 0, length: 64 * 1024 },
    });
    return object ? titleFromHead(await object.text()) : "";
  };

  let target: Response | PublishTarget;
  if (row.creates) {
    const title =
      row.title ||
      (await pageTitle()) ||
      (row.kind === "artifact" ? "Untitled artifact" : "Untitled site");
    target = { slug: row.siteSlug, kind: row.kind, title, existing: null };
    if (row.sourceRepo) {
      const sourceProblem = await checkSourceCommit(
        env,
        { slug: row.siteSlug, sourceRepo: row.sourceRepo, currentVersion: null },
        row.sourceCommit,
      );
      if (sourceProblem) {
        // Usually the push has not landed yet. Keep the upload and its repo: push, then commit
        // again.
        await release();
        return sourceProblem;
      }
    }
  } else {
    target = await resolvePublishTarget(
      env.DB,
      identity,
      {
        targetSlug: row.siteSlug,
        requireExpectedVersion: Boolean(row.ownerOnly),
        expectedCurrentVersion: row.expectedVersion,
        title: row.title,
      },
      pageTitle,
    );
    if (!(target instanceof Response)) {
      target = (await checkSourceCommit(env, target.existing, row.sourceCommit)) ?? target;
    }
  }

  const published =
    target instanceof Response
      ? target
      : await recordVersion(env.DB, identity, target, {
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
  if (published instanceof Response) {
    // The version can never go live. Drop its files, and the repo it would have created.
    await deleteUpload(env, row.id, prefix, row.sourceRepo);
  }
  return published;
}

/** A new nap's URL is held by an open upload until it expires. */
async function isHeldByUpload(db: D1Database, slug: string) {
  const held = await db
    .prepare(
      `SELECT 1 FROM uploads
       WHERE site_slug = ? AND creates = 1 AND committed_at IS NULL AND expires_at > ?`,
    )
    .bind(slug, now())
    .first();
  return Boolean(held);
}

async function listSizes(bucket: R2Bucket, prefix: string) {
  const sizes = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const item of listed.objects) sizes.set(item.key.slice(prefix.length), item.size);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return sizes;
}

async function deleteUpload(
  env: DirectUploadEnv,
  id: string,
  prefix: string,
  sourceRepo: string | null,
) {
  if (sourceRepo) await deleteSourceRepo(env, sourceRepo);
  const keys = [...(await listSizes(env.SITES, prefix)).keys()].map((path) => prefix + path);
  for (let start = 0; start < keys.length; start += 1000) {
    await env.SITES.delete(keys.slice(start, start + 1000));
  }
  await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(id).run();
}

/** Deletes a few expired uploads and their files. Runs when an upload starts. */
async function cleanupExpiredUploads(env: DirectUploadEnv) {
  const { results } = await env.DB.prepare(
    `SELECT id, site_slug AS siteSlug, version_id AS versionId, source_repo AS sourceRepo
     FROM uploads WHERE committed_at IS NULL AND expires_at < ? LIMIT 5`,
  )
    .bind(now())
    .all<{ id: string; siteSlug: string; versionId: string; sourceRepo: string | null }>();
  for (const upload of results) {
    await deleteUpload(
      env,
      upload.id,
      objectKey(upload.siteSlug, upload.versionId, ""),
      upload.sourceRepo,
    );
  }
  await env.DB.prepare("DELETE FROM uploads WHERE committed_at IS NOT NULL AND committed_at < ?")
    .bind(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .run();
}

const noStore = { "cache-control": "no-store" };
