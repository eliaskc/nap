import { Effect } from "effect";
import { ensureProfile, getIdentity, type Identity } from "~/lib/nap-server";
import { COLLECTION_PATTERN, SLUG_PATTERN, siteManifest } from "~/lib/site-manifest";
import { Database } from "~/server/database";
import { fail, HttpError, json } from "~/server/http";

const MAX_DOCUMENT_BYTES = 64 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
// The changes feed is how pages load a whole collection, so it sends more per request, up to a
// size budget so a page of large documents stays small enough to hold in memory.
const MAX_CHANGES_PAGE_SIZE = 1000;
const MAX_CHANGES_PAGE_BYTES = 4 * 1024 * 1024;
// Nap's ids are UUIDs. Apps that use put() choose their own, for example "q3" or "settings".
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SINCE_PATTERN = /^\d{1,15}$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
// The next change number for the site. D1 runs one write at a time, so this is safe in a statement.
const NEXT_SEQ = "(SELECT coalesce(max(seq), 0) + 1 FROM site_documents WHERE site_slug = ?1)";
const COLUMNS = `id, data_json AS dataJson, version, seq, created_by_email AS createdBy,
  updated_by_email AS updatedBy, created_at AS createdAt, updated_at AS updatedAt,
  deleted_at AS deletedAt`;

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

export type DocumentChange = ReturnType<typeof toChange>;

/**
 * Whose collections a /_nap/data/<path> request on a site's host uses. `@<site>/<collection>...`
 * is another site's, which that site allows in its nap.json; anything else is the host's own.
 */
export function siteDataTarget(hostSlug: string, path: string) {
  const match = path.match(/^@([^/]*)(?:\/(.*))?$/);
  if (!match || match[1] === hostSlug) {
    return { slug: hostSlug, path: match ? (match[2] ?? "") : path, from: undefined };
  }
  return { slug: match[1], path: match[2] ?? "", from: hostSlug };
}

export const handleSiteDataRequest = Effect.fn("handleSiteDataRequest")(function* <R = never>(
  slug: string,
  request: Request,
  path: string,
  options: {
    /**
     * For artifact frames: the person from the frame token. Access does not protect that path,
     * so the request headers say nothing, and the request must not count as using Nap.
     */
    frameIdentity?: Identity;
    /**
     * For another site's pages: its slug. They may use only the collections this site's live
     * nap.json allows them ("data": { "allow": { "<from>": ["<collection>"] } }).
     */
    from?: string;
    /** Runs after each committed write, with what the changes feed will return for it. */
    onChange?: (collection: string, change: DocumentChange) => Effect.Effect<void, never, R>;
  } = {},
) {
  const { frameIdentity, from, onChange } = options;
  const identity = frameIdentity ?? getIdentity(request);
  if (!SLUG_PATTERN.test(slug) || !(yield* canViewSite(slug, identity.email))) {
    return yield* fail(404, "Site not found");
  }

  if (!frameIdentity) yield* ensureProfile(identity);

  const segments = path.split("/").filter(Boolean);
  const collection = segments[0] ?? "";
  const id = segments[1];

  if (!COLLECTION_PATTERN.test(collection)) {
    return yield* fail(
      400,
      "Collection names must start with a letter and contain only lowercase letters, numbers, _ or -",
    );
  }
  if (segments.length > 2 || (id !== undefined && !DOCUMENT_ID_PATTERN.test(id))) {
    return yield* fail(
      400,
      "Document ids must start with a letter or number and contain at most 64 letters, numbers, _ or -",
    );
  }
  if (from !== undefined && !(yield* allowsSite(slug, from, collection))) {
    return yield* fail(
      403,
      `The site "${slug}" does not let "${from}" use its collection "${collection}". ` +
        `Its nap.json needs { "data": { "allow": { "${from}": ["${collection}"] } } }`,
    );
  }

  const db = yield* Database;
  const where = { slug, collection };
  const committed = Effect.fnUntraced(function* (row: DocumentRow) {
    if (onChange) yield* onChange(collection, toChange(row));
    return toDocument(row);
  });

  if (!id) {
    if (request.method === "GET") {
      const url = new URL(request.url);
      return url.searchParams.has("since")
        ? yield* listChanges(where, url)
        : yield* listDocuments(where, url);
    }
    if (request.method === "POST") {
      const data = yield* readJsonDocument(request);
      const row = yield* db.first<DocumentRow>(
        `INSERT INTO site_documents (
           site_slug, collection, id, data_json, seq, created_by_email, updated_by_email
         ) VALUES (?1, ?2, ?3, ?4, ${NEXT_SEQ}, ?5, ?5)
         RETURNING ${COLUMNS}`,
        slug,
        collection,
        crypto.randomUUID(),
        JSON.stringify(data),
        identity.email,
      );
      return json({ document: yield* committed(row!) }, { status: 201 });
    }
    return yield* methodNotAllowed("GET, POST");
  }

  const precondition = yield* readPrecondition(request);

  if (request.method === "GET") {
    const row = yield* getRow(where, id);
    return row && !row.deletedAt
      ? json({ document: toDocument(row) })
      : yield* fail(404, "Document not found");
  }

  if (request.method === "PUT") {
    const data = yield* readJsonDocument(request);
    const row = yield* putDocument(where, id, JSON.stringify(data), identity.email, precondition);
    if (row) {
      return json({ document: yield* committed(row) }, { status: row.version === 1 ? 201 : 200 });
    }
    yield* explainFailedWrite(where, id, precondition);
    return yield* fail(500, "Write failed");
  }

  if (request.method === "PATCH") {
    if (precondition.kind === "absent") {
      return yield* fail(400, "PATCH needs a document that exists");
    }
    const patch = yield* readJsonDocument(request);
    const patchJson = JSON.stringify(patch);
    const row = yield* db.first<DocumentRow>(
      `UPDATE site_documents
       SET data_json = json_patch(data_json, ?4), version = version + 1, seq = ${NEXT_SEQ},
           updated_by_email = ?5, updated_at = ${NOW}
       WHERE site_slug = ?1 AND collection = ?2 AND id = ?3 AND deleted_at IS NULL
         AND (?6 IS NULL OR version = ?6)
         AND length(CAST(json_patch(data_json, ?4) AS BLOB)) <= ${MAX_DOCUMENT_BYTES}
       RETURNING ${COLUMNS}`,
      slug,
      collection,
      id,
      patchJson,
      identity.email,
      versionOf(precondition),
    );
    if (row) return json({ document: yield* committed(row) });
    // The document exists at the right version, so the patched document was too big.
    yield* explainFailedWrite(where, id, precondition);
    return yield* fail(413, "Document exceeds the 64 KiB limit");
  }

  if (request.method === "DELETE") {
    if (precondition.kind === "absent") {
      return yield* fail(400, "DELETE needs a document that exists");
    }
    const row = yield* db.first<DocumentRow>(
      `UPDATE site_documents
       SET deleted_at = ${NOW}, version = version + 1, seq = ${NEXT_SEQ},
           updated_by_email = ?4, updated_at = ${NOW}
       WHERE site_slug = ?1 AND collection = ?2 AND id = ?3 AND deleted_at IS NULL
         AND (?5 IS NULL OR version = ?5)
       RETURNING ${COLUMNS}`,
      slug,
      collection,
      id,
      identity.email,
      versionOf(precondition),
    );
    if (row) {
      yield* committed(row);
      return new Response(null, { status: 204 });
    }
    yield* explainFailedWrite(where, id, precondition);
    return yield* fail(500, "Write failed");
  }

  return yield* methodNotAllowed("GET, PUT, PATCH, DELETE");
});

type Where = { slug: string; collection: string };

/** Whether the live version of `slug` lets pages of `from` use `collection`. */
const allowsSite = Effect.fnUntraced(function* (slug: string, from: string, collection: string) {
  const db = yield* Database;
  const site = yield* db.first<{ currentVersion: string | null }>(
    `SELECT current_version AS currentVersion FROM sites WHERE slug = ?`,
    slug,
  );
  if (!site?.currentVersion) return false;
  const { allow } = (yield* siteManifest(slug, site.currentVersion)).data;
  return Object.hasOwn(allow, from) && allow[from].includes(collection);
});

const putDocument = Effect.fnUntraced(function* (
  { slug, collection }: Where,
  id: string,
  dataJson: string,
  email: string,
  precondition: Precondition,
) {
  const db = yield* Database;
  if (precondition.kind === "exists" || precondition.kind === "version") {
    return yield* db.first<DocumentRow>(
      `UPDATE site_documents
         SET data_json = ?4, version = version + 1, seq = ${NEXT_SEQ},
             updated_by_email = ?5, updated_at = ${NOW}
         WHERE site_slug = ?1 AND collection = ?2 AND id = ?3 AND deleted_at IS NULL
           AND (?6 IS NULL OR version = ?6)
         RETURNING ${COLUMNS}`,
      slug,
      collection,
      id,
      dataJson,
      email,
      versionOf(precondition),
    );
  }

  // Create, or replace. A deleted document comes back as new, but its version keeps counting up,
  // so writes based on the old document still fail.
  const onlyIfAbsent =
    precondition.kind === "absent" ? "WHERE site_documents.deleted_at IS NOT NULL" : "";
  return yield* db.first<DocumentRow>(
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
    slug,
    collection,
    id,
    dataJson,
    email,
  );
});

/**
 * Why a write changed nothing: fails with 404, or 409 with the current document. Succeeds when
 * neither explains it.
 */
const explainFailedWrite = Effect.fnUntraced(function* (
  where: Where,
  id: string,
  precondition: Precondition,
) {
  const row = yield* getRow(where, id);
  const exists = row && !row.deletedAt;
  if (precondition.kind === "absent" && exists) {
    return yield* fail(409, "Document already exists", { document: toDocument(row) });
  }
  if (!exists) return yield* fail(404, "Document not found");
  if (precondition.kind === "version" && row.version !== precondition.version) {
    return yield* fail(409, "Document changed since you read it", { document: toDocument(row) });
  }
});

const listDocuments = Effect.fnUntraced(function* ({ slug, collection }: Where, url: URL) {
  const limit = pageSize(url);
  const cursor = url.searchParams.get("cursor");

  let query = `SELECT ${COLUMNS}
    FROM site_documents
    WHERE site_slug = ? AND collection = ? AND deleted_at IS NULL`;
  const bindings: Array<string | number> = [slug, collection];

  if (cursor) {
    if (!DOCUMENT_ID_PATTERN.test(cursor)) return yield* fail(400, "Invalid cursor");
    query += ` AND (created_at, id) < (
      SELECT created_at, id FROM site_documents
      WHERE id = ? AND site_slug = ? AND collection = ? AND deleted_at IS NULL
    )`;
    bindings.push(cursor, slug, collection);
  }

  query += " ORDER BY created_at DESC, id DESC LIMIT ?";
  bindings.push(limit + 1);
  const db = yield* Database;
  const results = yield* db.all<DocumentRow>(query, ...bindings);
  const hasMore = results.length > limit;
  const page = results.slice(0, limit);

  return json({
    documents: page.map(toDocument),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  });
});

/**
 * The changes feed: every write after `since`, oldest first, deletes included. `since=0` is the
 * whole collection; it leaves out deleted documents, which a page loading from scratch has never
 * seen. Pass the returned `since` back to get the next changes.
 */
const listChanges = Effect.fnUntraced(function* ({ slug, collection }: Where, url: URL) {
  const since = url.searchParams.get("since") ?? "";
  if (!SINCE_PATTERN.test(since)) {
    return yield* fail(400, "since must be a number from an earlier response");
  }
  const limit = pageSize(url, MAX_CHANGES_PAGE_SIZE);
  const fromScratch = Number(since) === 0;
  const db = yield* Database;
  // head: the collection's latest change, read in the same statement as the page.
  const results = yield* db.all<DocumentRow & { head: number }>(
    `SELECT ${COLUMNS},
       (SELECT max(seq) FROM site_documents WHERE site_slug = ?1 AND collection = ?2) AS head
     FROM site_documents
     WHERE site_slug = ?1 AND collection = ?2 AND seq > ?3 AND (?3 > 0 OR deleted_at IS NULL)
     ORDER BY seq LIMIT ?4`,
    slug,
    collection,
    Number(since),
    limit + 1,
  );
  let page = results.slice(0, limit);
  let bytes = 0;
  const fits = page.findIndex((row) => (bytes += row.dataJson.length) > MAX_CHANGES_PAGE_BYTES);
  if (fits > 0) page = page.slice(0, fits);
  const hasMore = results.length > page.length;
  // From scratch, everything after the last document sent is a delete, so skip past it.
  const head = fromScratch && !hasMore ? (results[0]?.head ?? 0) : 0;
  return json(
    {
      changes: page.map(toChange),
      since: Math.max(page.at(-1)?.seq ?? Number(since), head),
      hasMore,
    },
    { headers: { "cache-control": "no-store" } },
  );
});

function pageSize(url: URL, max = MAX_PAGE_SIZE) {
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  return Number.isFinite(requested) ? Math.min(Math.max(requested, 1), max) : DEFAULT_PAGE_SIZE;
}

const getRow = Effect.fnUntraced(function* ({ slug, collection }: Where, id: string) {
  const db = yield* Database;
  return yield* db.first<DocumentRow>(
    `SELECT ${COLUMNS} FROM site_documents
     WHERE site_slug = ? AND collection = ? AND id = ?`,
    slug,
    collection,
    id,
  );
});

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

const badRequest = (error: string) => new HttpError({ status: 400, body: { error } });

function readPrecondition(request: Request): Effect.Effect<Precondition, HttpError> {
  const ifMatch = request.headers.get("if-match")?.trim();
  const ifNoneMatch = request.headers.get("if-none-match")?.trim();
  if (ifMatch && ifNoneMatch) {
    return Effect.fail(badRequest("Send If-Match or If-None-Match, not both"));
  }
  if (ifNoneMatch) {
    return ifNoneMatch === "*"
      ? Effect.succeed({ kind: "absent" })
      : Effect.fail(badRequest('If-None-Match must be "*"'));
  }
  if (!ifMatch) return Effect.succeed({ kind: "none" });
  if (ifMatch === "*") return Effect.succeed({ kind: "exists" });
  const match = ifMatch.match(/^(?:W\/)?"?(\d{1,15})"?$/);
  if (!match) return Effect.fail(badRequest('If-Match must be "*" or a document version'));
  return Effect.succeed({ kind: "version", version: Number(match[1]) });
}

function versionOf(precondition: Precondition) {
  return precondition.kind === "version" ? precondition.version : null;
}

const methodNotAllowed = (allow: string) => fail(405, "Method not allowed", {}, { allow });

/** The request's JSON object, read at most 64 KiB at a time. */
const readJsonDocument = Effect.fnUntraced(function* (request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json" && contentType !== "application/merge-patch+json") {
    return yield* fail(415, "Content-Type must be application/json");
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) {
    return yield* fail(413, "Document exceeds the 64 KiB limit");
  }

  const reader = request.body?.getReader();
  if (!reader) return yield* fail(400, "Missing JSON document");

  const bytes = yield* Effect.promise(() => readLimited(reader, MAX_DOCUMENT_BYTES));
  if (!bytes) return yield* fail(413, "Document exceeds the 64 KiB limit");

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return yield* fail(400, "Invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return yield* fail(400, "Document must be a JSON object");
  }
  return value as Record<string, unknown>;
});

/** The whole stream, or null (and the stream cancelled) once it passes `maxBytes`. */
async function readLimited(reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const canViewSite = Effect.fn("canViewSlug")(function* (slug: string, email: string) {
  const db = yield* Database;
  const site = yield* db.first(
    `SELECT 1
       FROM sites
       LEFT JOIN site_viewers
         ON site_viewers.site_slug = sites.slug AND lower(site_viewers.email) = lower(?)
       WHERE sites.slug = ? AND (
         sites.visibility = 'everyone'
         OR lower(sites.created_by_email) = lower(?)
         OR (sites.visibility = 'selected' AND site_viewers.email IS NOT NULL)
       )`,
    email,
    slug,
    email,
  );
  return Boolean(site);
});

/** Which of these people may view the site, lowercased. The same rule as canViewSite. */
export const viewersAmong = Effect.fn("viewersAmong")(function* (slug: string, emails: string[]) {
  if (emails.length === 0) return new Set<string>();
  const db = yield* Database;
  const results = yield* db.all<{ email: string }>(
    `SELECT lower(people.value) AS email
       FROM json_each(?2) AS people
       JOIN sites ON sites.slug = ?1
       LEFT JOIN site_viewers
         ON site_viewers.site_slug = sites.slug AND lower(site_viewers.email) = lower(people.value)
       WHERE sites.visibility = 'everyone'
         OR lower(sites.created_by_email) = lower(people.value)
         OR (sites.visibility = 'selected' AND site_viewers.email IS NOT NULL)`,
    slug,
    JSON.stringify(emails),
  );
  return new Set(results.map((row) => row.email));
});
