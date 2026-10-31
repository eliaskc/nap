import { ensureProfile, getIdentity, json, type Identity } from "~/lib/nap-server";

const MAX_DOCUMENT_BYTES = 64 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const COLLECTION_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
// Nap's ids are UUIDs. Apps that use put() choose their own, for example "q3" or "settings".
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SINCE_PATTERN = /^\d{1,15}$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
// The next change number for the site. D1 runs one write at a time, so this is safe in a statement.
const NEXT_SEQ = "(SELECT coalesce(max(seq), 0) + 1 FROM site_documents WHERE site_slug = ?1)";
const COLUMNS = `id, data_json AS dataJson, version, seq, created_by_email AS createdBy,
  updated_by_email AS updatedBy, created_at AS createdAt, updated_at AS updatedAt,
  deleted_at AS deletedAt`;

type SiteDataEnv = {
  DB: D1Database;
};

type DocumentRow = {
  id: string;
  dataJson: string;
  version: number;
  seq: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

/**
 * If-Match: "<version>" writes only if the document is at that version; If-Match: * only if it
 * exists. If-None-Match: * writes only if it does not exist yet.
 */
type Precondition =
  | { kind: "none" }
  | { kind: "exists" }
  | { kind: "version"; version: number }
  | { kind: "absent" };

export async function handleSiteDataRequest(
  env: SiteDataEnv,
  slug: string,
  request: Request,
  path: string,
  options: {
    /**
     * For artifact frames: the person from the frame token. Access does not protect that path,
     * so the request headers say nothing, and the request must not count as using Nap.
     */
    frameIdentity?: Identity;
    /** Called after each committed write, with what the changes feed will return for it. */
    onChange?: (collection: string, change: ReturnType<typeof toChange>) => void;
  } = {},
) {
  const { frameIdentity, onChange } = options;
  const identity = frameIdentity ?? getIdentity(request);
  if (!(await canViewSite(env.DB, slug, identity.email))) {
    return json({ error: "Site not found" }, { status: 404 });
  }

  if (!frameIdentity) await ensureProfile(env.DB, identity);

  const segments = path.split("/").filter(Boolean);
  const collection = segments[0] ?? "";
  const id = segments[1];

  if (!COLLECTION_PATTERN.test(collection)) {
    return json(
      {
        error:
          "Collection names must start with a letter and contain only lowercase letters, numbers, _ or -",
      },
      { status: 400 },
    );
  }
  if (segments.length > 2 || (id !== undefined && !DOCUMENT_ID_PATTERN.test(id))) {
    return json(
      {
        error:
          "Document ids must start with a letter or number and contain at most 64 letters, numbers, _ or -",
      },
      { status: 400 },
    );
  }

  const db = env.DB;
  const where = { slug, collection };
  const committed = (row: DocumentRow) => {
    onChange?.(collection, toChange(row));
    return toDocument(row);
  };

  if (!id) {
    if (request.method === "GET") {
      const url = new URL(request.url);
      return url.searchParams.has("since")
        ? listChanges(db, where, url)
        : listDocuments(db, where, url);
    }
    if (request.method === "POST") {
      const data = await readJsonObject(request);
      if (data instanceof Response) return data;
      const row = await db
        .prepare(
          `INSERT INTO site_documents (
             site_slug, collection, id, data_json, seq, created_by_email, updated_by_email
           ) VALUES (?1, ?2, ?3, ?4, ${NEXT_SEQ}, ?5, ?5)
           RETURNING ${COLUMNS}`,
        )
        .bind(slug, collection, crypto.randomUUID(), JSON.stringify(data), identity.email)
        .first<DocumentRow>();
      return json({ document: committed(row!) }, { status: 201 });
    }
    return methodNotAllowed("GET, POST");
  }

  const precondition = readPrecondition(request);
  if (precondition instanceof Response) return precondition;

  if (request.method === "GET") {
    const row = await getRow(db, where, id);
    return row && !row.deletedAt
      ? json({ document: toDocument(row) })
      : json({ error: "Document not found" }, { status: 404 });
  }

  if (request.method === "PUT") {
    const data = await readJsonObject(request);
    if (data instanceof Response) return data;
    const row = await putDocument(
      db,
      where,
      id,
      JSON.stringify(data),
      identity.email,
      precondition,
    );
    if (row) return json({ document: committed(row) }, { status: row.version === 1 ? 201 : 200 });
    return (await failedWrite(db, where, id, precondition)) ?? writeFailed();
  }

  if (request.method === "PATCH") {
    if (precondition.kind === "absent") {
      return json({ error: "PATCH needs a document that exists" }, { status: 400 });
    }
    const patch = await readJsonObject(request);
    if (patch instanceof Response) return patch;
    const patchJson = JSON.stringify(patch);
    const row = await db
      .prepare(
        `UPDATE site_documents
         SET data_json = json_patch(data_json, ?4), version = version + 1, seq = ${NEXT_SEQ},
             updated_by_email = ?5, updated_at = ${NOW}
         WHERE site_slug = ?1 AND collection = ?2 AND id = ?3 AND deleted_at IS NULL
           AND (?6 IS NULL OR version = ?6)
           AND length(CAST(json_patch(data_json, ?4) AS BLOB)) <= ${MAX_DOCUMENT_BYTES}
         RETURNING ${COLUMNS}`,
      )
      .bind(slug, collection, id, patchJson, identity.email, versionOf(precondition))
      .first<DocumentRow>();
    if (row) return json({ document: committed(row) });
    // The document exists at the right version, so the patched document was too big.
    return (
      (await failedWrite(db, where, id, precondition)) ??
      json({ error: "Document exceeds the 64 KiB limit" }, { status: 413 })
    );
  }

  if (request.method === "DELETE") {
    if (precondition.kind === "absent") {
      return json({ error: "DELETE needs a document that exists" }, { status: 400 });
    }
    const row = await db
      .prepare(
        `UPDATE site_documents
         SET deleted_at = ${NOW}, version = version + 1, seq = ${NEXT_SEQ},
             updated_by_email = ?4, updated_at = ${NOW}
         WHERE site_slug = ?1 AND collection = ?2 AND id = ?3 AND deleted_at IS NULL
           AND (?5 IS NULL OR version = ?5)
         RETURNING ${COLUMNS}`,
      )
      .bind(slug, collection, id, identity.email, versionOf(precondition))
      .first<DocumentRow>();
    if (row) {
      committed(row);
      return new Response(null, { status: 204 });
    }
    return (await failedWrite(db, where, id, precondition)) ?? writeFailed();
  }

  return methodNotAllowed("GET, PUT, PATCH, DELETE");
}

type Where = { slug: string; collection: string };

async function putDocument(
  db: D1Database,
  { slug, collection }: Where,
  id: string,
  dataJson: string,
  email: string,
  precondition: Precondition,
) {
  if (precondition.kind === "exists" || precondition.kind === "version") {
    return db
      .prepare(
        `UPDATE site_documents
         SET data_json = ?4, version = version + 1, seq = ${NEXT_SEQ},
             updated_by_email = ?5, updated_at = ${NOW}
         WHERE site_slug = ?1 AND collection = ?2 AND id = ?3 AND deleted_at IS NULL
           AND (?6 IS NULL OR version = ?6)
         RETURNING ${COLUMNS}`,
      )
      .bind(slug, collection, id, dataJson, email, versionOf(precondition))
      .first<DocumentRow>();
  }

  // Create, or replace. A deleted document comes back as new, but its version keeps counting up,
  // so writes based on the old document still fail.
  const onlyIfAbsent =
    precondition.kind === "absent" ? "WHERE site_documents.deleted_at IS NOT NULL" : "";
  return db
    .prepare(
      `INSERT INTO site_documents (
         site_slug, collection, id, data_json, seq, created_by_email, updated_by_email
       ) VALUES (?1, ?2, ?3, ?4, ${NEXT_SEQ}, ?5, ?5)
       ON CONFLICT (site_slug, collection, id) DO UPDATE SET
         data_json = excluded.data_json,
         version = site_documents.version + 1,
         seq = excluded.seq,
         updated_by_email = excluded.updated_by_email,
         updated_at = ${NOW},
         created_by_email = CASE WHEN site_documents.deleted_at IS NULL
           THEN site_documents.created_by_email ELSE excluded.created_by_email END,
         created_at = CASE WHEN site_documents.deleted_at IS NULL
           THEN site_documents.created_at ELSE ${NOW} END,
         deleted_at = NULL
       ${onlyIfAbsent}
       RETURNING ${COLUMNS}`,
    )
    .bind(slug, collection, id, dataJson, email)
    .first<DocumentRow>();
}

/**
 * Why a write changed nothing: 404, or 409 with the current document. Null when neither
 * explains it.
 */
async function failedWrite(db: D1Database, where: Where, id: string, precondition: Precondition) {
  const row = await getRow(db, where, id);
  const exists = row && !row.deletedAt;
  if (precondition.kind === "absent" && exists) {
    return json({ error: "Document already exists", document: toDocument(row) }, { status: 409 });
  }
  if (!exists) return json({ error: "Document not found" }, { status: 404 });
  if (precondition.kind === "version" && row.version !== precondition.version) {
    return json(
      { error: "Document changed since you read it", document: toDocument(row) },
      { status: 409 },
    );
  }
  return null;
}

function writeFailed() {
  return json({ error: "Write failed" }, { status: 500 });
}

async function listDocuments(db: D1Database, { slug, collection }: Where, url: URL) {
  const limit = pageSize(url);
  const cursor = url.searchParams.get("cursor");

  let query = `SELECT ${COLUMNS}
    FROM site_documents
    WHERE site_slug = ? AND collection = ? AND deleted_at IS NULL`;
  const bindings: Array<string | number> = [slug, collection];

  if (cursor) {
    if (!DOCUMENT_ID_PATTERN.test(cursor)) {
      return json({ error: "Invalid cursor" }, { status: 400 });
    }
    query += ` AND (created_at, id) < (
      SELECT created_at, id FROM site_documents
      WHERE id = ? AND site_slug = ? AND collection = ? AND deleted_at IS NULL
    )`;
    bindings.push(cursor, slug, collection);
  }

  query += " ORDER BY created_at DESC, id DESC LIMIT ?";
  bindings.push(limit + 1);
  const { results } = await db
    .prepare(query)
    .bind(...bindings)
    .all<DocumentRow>();
  const hasMore = results.length > limit;
  const page = results.slice(0, limit);

  return json({
    documents: page.map(toDocument),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  });
}

/**
 * The changes feed: every write after `since`, oldest first, deletes included. `since=0` is the
 * whole collection. Pass the returned `since` back to get the next changes.
 */
async function listChanges(db: D1Database, { slug, collection }: Where, url: URL) {
  const since = url.searchParams.get("since") ?? "";
  if (!SINCE_PATTERN.test(since)) {
    return json({ error: "since must be a number from an earlier response" }, { status: 400 });
  }
  const limit = pageSize(url);
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS}
       FROM site_documents
       WHERE site_slug = ? AND collection = ? AND seq > ?
       ORDER BY seq LIMIT ?`,
    )
    .bind(slug, collection, Number(since), limit + 1)
    .all<DocumentRow>();
  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  return json(
    {
      changes: page.map(toChange),
      since: page.at(-1)?.seq ?? Number(since),
      hasMore,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function pageSize(url: URL) {
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  return Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
}

async function getRow(db: D1Database, { slug, collection }: Where, id: string) {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM site_documents
       WHERE site_slug = ? AND collection = ? AND id = ?`,
    )
    .bind(slug, collection, id)
    .first<DocumentRow>();
}

function toDocument(row: DocumentRow) {
  return {
    id: row.id,
    data: JSON.parse(row.dataJson) as Record<string, unknown>,
    version: row.version,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toChange(row: DocumentRow) {
  if (!row.deletedAt) return toDocument(row);
  return {
    id: row.id,
    deleted: true,
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

function readPrecondition(request: Request): Precondition | Response {
  const ifMatch = request.headers.get("if-match")?.trim();
  const ifNoneMatch = request.headers.get("if-none-match")?.trim();
  if (ifMatch && ifNoneMatch) {
    return json({ error: "Send If-Match or If-None-Match, not both" }, { status: 400 });
  }
  if (ifNoneMatch) {
    return ifNoneMatch === "*"
      ? { kind: "absent" }
      : json({ error: 'If-None-Match must be "*"' }, { status: 400 });
  }
  if (!ifMatch) return { kind: "none" };
  if (ifMatch === "*") return { kind: "exists" };
  const match = ifMatch.match(/^(?:W\/)?"?(\d{1,15})"?$/);
  if (!match) {
    return json({ error: 'If-Match must be "*" or a document version' }, { status: 400 });
  }
  return { kind: "version", version: Number(match[1]) };
}

function versionOf(precondition: Precondition) {
  return precondition.kind === "version" ? precondition.version : null;
}

function methodNotAllowed(allow: string) {
  return json({ error: "Method not allowed" }, { status: 405, headers: { allow } });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json" && contentType !== "application/merge-patch+json") {
    return json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) {
    return json({ error: "Document exceeds the 64 KiB limit" }, { status: 413 });
  }

  const reader = request.body?.getReader();
  if (!reader) return json({ error: "Missing JSON document" }, { status: 400 });

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      return json({ error: "Document exceeds the 64 KiB limit" }, { status: 413 });
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return json({ error: "Document must be a JSON object" }, { status: 400 });
    }
    return value as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400 });
  }
}

export async function canViewSite(db: D1Database, slug: string, email: string) {
  const site = await db
    .prepare(
      `SELECT 1
       FROM sites
       LEFT JOIN site_viewers
         ON site_viewers.site_slug = sites.slug AND lower(site_viewers.email) = lower(?)
       WHERE sites.slug = ? AND (
         sites.visibility = 'everyone'
         OR lower(sites.created_by_email) = lower(?)
         OR (sites.visibility = 'selected' AND site_viewers.email IS NOT NULL)
       )`,
    )
    .bind(email, slug, email)
    .first();
  return Boolean(site);
}

/** Which of these people may view the site, lowercased. The same rule as canViewSite. */
export async function viewersAmong(db: D1Database, slug: string, emails: string[]) {
  if (emails.length === 0) return new Set<string>();
  const { results } = await db
    .prepare(
      `SELECT lower(people.value) AS email
       FROM json_each(?2) AS people
       JOIN sites ON sites.slug = ?1
       LEFT JOIN site_viewers
         ON site_viewers.site_slug = sites.slug AND lower(site_viewers.email) = lower(people.value)
       WHERE sites.visibility = 'everyone'
         OR lower(sites.created_by_email) = lower(people.value)
         OR (sites.visibility = 'selected' AND site_viewers.email IS NOT NULL)`,
    )
    .bind(slug, JSON.stringify(emails))
    .all<{ email: string }>();
  return new Set(results.map((row) => row.email));
}
