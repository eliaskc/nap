import { Effect, Predicate } from "effect";
import { ensureProfile, getIdentity } from "~/lib/nap-server";
import { findViewableNap } from "~/lib/site-serving";
import { Database } from "~/server/database";
import {
  fail,
  failNoStore,
  json,
  noStore,
  readJson,
  requireJsonBody,
  requireSameSite,
} from "~/server/http";

/**
 * Comments on artifacts. People use them from the Nap bar (`/artifact/<slug>/_nap/comments`);
 * agents use the same calls under `/_nap/api/naps/<id>/comments`. Callers check access
 * first. Anyone who can view an artifact can comment, reply, resolve, and reopen.
 *
 *   GET   /comments?status=open|resolved   threads with their replies, oldest first
 *   POST  /comments                        { body, path?, quote?, prefix?, suffix? }
 *   POST  /comments/<id>/replies           { body }
 *   PATCH /comments/<id>                   { resolved: true | false }
 */

const MAX_BODY = 10_000;
const MAX_QUOTE = 2_000;
const MAX_CONTEXT = 32;
const MAX_PATH = 512;
const MAX_THREADS = 500;
const ID_PATTERN = /^[0-9a-f-]{36}$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export type CommentAuthor = { email: string; client?: string };

type CommentRow = {
  id: string;
  threadId: string | null;
  path: string;
  versionId: string | null;
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
  authorEmail: string;
  authorName: string | null;
  client: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedByEmail: string | null;
};

/**
 * `/artifact/<slug>/_nap/comments[/...]`, for people signed in through Access. The comments UI in
 * the Nap bar calls it. The sandboxed artifact frame cannot: its requests are cross-site, and
 * responses carry no CORS headers.
 */
export const handleSiteCommentsRequest = Effect.fn("handleSiteCommentsRequest")(function* (
  slug: string,
  request: Request,
  rest: string,
) {
  const identity = getIdentity(request);
  const access = yield* findViewableNap(slug, identity.email);
  if (access.status !== "allowed" || access.nap.kind !== "artifact") {
    return yield* failNoStore(404, "Not found");
  }
  if (request.method !== "GET") {
    // Other origins cannot send a JSON body without a preflight, which Nap never answers.
    yield* requireSameSite(request);
    yield* ensureProfile(identity);
  }
  return yield* handleComments(slug, { email: identity.email }, request, rest);
});

export const handleComments = Effect.fn("handleComments")(function* (
  slug: string,
  author: CommentAuthor,
  request: Request,
  rest: string,
) {
  const method = request.method;
  const segments = rest.split("/");
  const [, id, action] = segments;
  if (segments.length > 3 || (id !== undefined && !ID_PATTERN.test(id))) return yield* notFound();

  if (!id && method === "GET") {
    const status = new URL(request.url).searchParams.get("status");
    return json({ comments: yield* listThreads(slug, status) }, { headers: noStore });
  }

  if (method !== "POST" && method !== "PATCH") return yield* fail(405, "Method not allowed");
  yield* requireJsonBody(request, "Send JSON");
  const input = (yield* readJson(request)) as Record<string, unknown> | null;
  if (!input || typeof input !== "object") return yield* fail(400, "Invalid JSON");

  const db = yield* Database;
  if (!id && method === "POST") {
    const body = text(input.body, MAX_BODY);
    if (body === null) return yield* fail(400, "The comment is too long");
    if (!body) return yield* fail(400, "Write a comment");
    const quote = text(input.quote, MAX_QUOTE);
    if (quote === null) return yield* fail(400, "The quote is too long");
    const path = text(input.path, MAX_PATH) || "/";
    if (!path.startsWith("/")) return yield* fail(400, "path starts with /");

    const commentId = crypto.randomUUID();
    yield* db.run(
      `INSERT INTO comments (id, site_slug, path, version_id, quote, prefix, suffix, body,
                             author_email, client)
       SELECT ?, slug, ?, current_version, ?, ?, ?, ?, ?, ? FROM sites WHERE slug = ?`,
      commentId,
      path,
      quote,
      quote ? context(input.prefix, "end") : "",
      quote ? context(input.suffix, "start") : "",
      body,
      author.email,
      author.client ?? "",
      slug,
    );
    return json({ comment: yield* getThread(slug, commentId) }, { status: 201 });
  }

  const thread = yield* db.first<{ id: string }>(
    "SELECT id FROM comments WHERE id = ? AND site_slug = ? AND thread_id IS NULL",
    id,
    slug,
  );
  if (!thread) return yield* notFound();

  if (action === "replies" && method === "POST") {
    const body = text(input.body, MAX_BODY);
    if (body === null) return yield* fail(400, "The reply is too long");
    if (!body) return yield* fail(400, "Write a reply");
    yield* db.run(
      `INSERT INTO comments (id, site_slug, thread_id, body, author_email, client)
       VALUES (?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      slug,
      id,
      body,
      author.email,
      author.client ?? "",
    );
    return json({ comment: yield* getThread(slug, id) }, { status: 201 });
  }

  if (action === undefined && method === "PATCH") {
    if (!Predicate.isBoolean(input.resolved)) {
      return yield* fail(400, "Send { resolved: true } or { resolved: false }");
    }
    yield* input.resolved
      ? db.run(
          `UPDATE comments SET resolved_at = ${NOW}, resolved_by_email = ?
           WHERE id = ? AND resolved_at IS NULL`,
          author.email,
          id,
        )
      : db.run("UPDATE comments SET resolved_at = NULL, resolved_by_email = NULL WHERE id = ?", id);
    return json({ comment: yield* getThread(slug, id) });
  }

  return yield* notFound();
});

const listThreads = Effect.fnUntraced(function* (slug: string, status: string | null) {
  const filter =
    status === "open"
      ? "AND resolved_at IS NULL"
      : status === "resolved"
        ? "AND resolved_at IS NOT NULL"
        : "";
  const db = yield* Database;
  const rows = yield* db.all<CommentRow>(
    `WITH threads AS (
       SELECT id FROM comments
       WHERE site_slug = ? AND thread_id IS NULL ${filter}
       ORDER BY created_at DESC LIMIT ${MAX_THREADS}
     )
     ${selectComments("comments.id IN (SELECT id FROM threads) OR comments.thread_id IN (SELECT id FROM threads)")}`,
    slug,
  );
  return toThreads(rows);
});

const getThread = Effect.fnUntraced(function* (slug: string, id: string) {
  const db = yield* Database;
  const rows = yield* db.all<CommentRow>(
    selectComments("comments.site_slug = ? AND (comments.id = ? OR comments.thread_id = ?)"),
    slug,
    id,
    id,
  );
  return toThreads(rows)[0] ?? null;
});

function selectComments(where: string) {
  return `SELECT comments.id, comments.thread_id AS threadId, comments.path,
                 comments.version_id AS versionId, comments.quote, comments.prefix, comments.suffix,
                 comments.body, comments.author_email AS authorEmail,
                 profiles.display_name AS authorName, comments.client,
                 comments.created_at AS createdAt, comments.resolved_at AS resolvedAt,
                 comments.resolved_by_email AS resolvedByEmail
          FROM comments LEFT JOIN profiles ON profiles.email = comments.author_email
          WHERE ${where}
          ORDER BY comments.created_at, comments.id`;
}

function toThreads(rows: Array<CommentRow>) {
  const message = (row: CommentRow) => ({
    id: row.id,
    body: row.body,
    author: { email: row.authorEmail, name: row.authorName || row.authorEmail },
    client: row.client || null,
    createdAt: row.createdAt,
  });
  const threads = new Map<string, ReturnType<typeof thread>>();
  const thread = (row: CommentRow) => ({
    ...message(row),
    path: row.path,
    version: row.versionId,
    quote: row.quote,
    prefix: row.prefix,
    suffix: row.suffix,
    resolved: row.resolvedAt !== null,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedByEmail,
    replies: [] as Array<ReturnType<typeof message>>,
  });
  for (const row of rows) if (!row.threadId) threads.set(row.id, thread(row));
  for (const row of rows) if (row.threadId) threads.get(row.threadId)?.replies.push(message(row));
  return [...threads.values()];
}

/** Trimmed text up to `max` characters. "" when missing, null when too long. */
function text(value: unknown, max: number) {
  if (!Predicate.isString(value)) return "";
  const trimmed = value.trim();
  return trimmed.length > max ? null : trimmed;
}

/** The characters next to the quote. Longer context is cut, keeping the side next to it. */
function context(value: unknown, keep: "start" | "end") {
  if (!Predicate.isString(value)) return "";
  return keep === "start" ? value.slice(0, MAX_CONTEXT) : value.slice(-MAX_CONTEXT);
}

const notFound = () => failNoStore(404, "Comment not found");
