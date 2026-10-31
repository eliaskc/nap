import { ensureProfile, getIdentity, json } from "~/lib/nap-server";
import { isCrossSite } from "~/lib/site-access";
import { findViewableNap } from "~/lib/site-serving";

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
const noStore = { "cache-control": "no-store" };

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
export async function handleSiteCommentsRequest(
  env: { DB: D1Database },
  slug: string,
  request: Request,
  rest: string,
) {
  const identity = getIdentity(request);
  const access = await findViewableNap(env.DB, slug, identity.email);
  if (access.status !== "allowed" || access.nap.kind !== "artifact") {
    return json({ error: "Not found" }, { status: 404, headers: noStore });
  }
  if (request.method !== "GET") {
    // Other origins cannot send a JSON body without a preflight, which Nap never answers.
    if (isCrossSite(request)) return json({ error: "Forbidden" }, { status: 403 });
    await ensureProfile(env.DB, identity);
  }
  return handleComments(env.DB, slug, { email: identity.email }, request, rest);
}

export async function handleComments(
  db: D1Database,
  slug: string,
  author: CommentAuthor,
  request: Request,
  rest: string,
) {
  const method = request.method;
  const segments = rest.split("/");
  const [, id, action] = segments;
  if (segments.length > 3 || (id !== undefined && !ID_PATTERN.test(id))) return notFound();

  if (!id && method === "GET") {
    const status = new URL(request.url).searchParams.get("status");
    return json({ comments: await listThreads(db, slug, status) }, { headers: noStore });
  }

  if (method !== "POST" && method !== "PATCH") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "Send JSON" }, { status: 415 });
  }
  const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!input || typeof input !== "object") return json({ error: "Invalid JSON" }, { status: 400 });

  if (!id && method === "POST") {
    const body = text(input.body, MAX_BODY);
    if (body === null) return json({ error: "The comment is too long" }, { status: 400 });
    if (!body) return json({ error: "Write a comment" }, { status: 400 });
    const quote = text(input.quote, MAX_QUOTE);
    if (quote === null) return json({ error: "The quote is too long" }, { status: 400 });
    const path = text(input.path, MAX_PATH) || "/";
    if (!path.startsWith("/")) return json({ error: "path starts with /" }, { status: 400 });

    const commentId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO comments (id, site_slug, path, version_id, quote, prefix, suffix, body,
                               author_email, client)
         SELECT ?, slug, ?, current_version, ?, ?, ?, ?, ?, ? FROM sites WHERE slug = ?`,
      )
      .bind(
        commentId,
        path,
        quote,
        quote ? context(input.prefix, "end") : "",
        quote ? context(input.suffix, "start") : "",
        body,
        author.email,
        author.client ?? "",
        slug,
      )
      .run();
    return json({ comment: await getThread(db, slug, commentId) }, { status: 201 });
  }

  const thread = await db
    .prepare("SELECT id FROM comments WHERE id = ? AND site_slug = ? AND thread_id IS NULL")
    .bind(id, slug)
    .first<{ id: string }>();
  if (!thread) return notFound();

  if (action === "replies" && method === "POST") {
    const body = text(input.body, MAX_BODY);
    if (body === null) return json({ error: "The reply is too long" }, { status: 400 });
    if (!body) return json({ error: "Write a reply" }, { status: 400 });
    await db
      .prepare(
        `INSERT INTO comments (id, site_slug, thread_id, body, author_email, client)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), slug, id, body, author.email, author.client ?? "")
      .run();
    return json({ comment: await getThread(db, slug, id) }, { status: 201 });
  }

  if (action === undefined && method === "PATCH") {
    if (typeof input.resolved !== "boolean") {
      return json({ error: "Send { resolved: true } or { resolved: false }" }, { status: 400 });
    }
    await (
      input.resolved
        ? db
            .prepare(
              `UPDATE comments SET resolved_at = ${NOW}, resolved_by_email = ?
               WHERE id = ? AND resolved_at IS NULL`,
            )
            .bind(author.email, id)
        : db
            .prepare(
              "UPDATE comments SET resolved_at = NULL, resolved_by_email = NULL WHERE id = ?",
            )
            .bind(id)
    ).run();
    return json({ comment: await getThread(db, slug, id) });
  }

  return notFound();
}

async function listThreads(db: D1Database, slug: string, status: string | null) {
  const filter =
    status === "open"
      ? "AND resolved_at IS NULL"
      : status === "resolved"
        ? "AND resolved_at IS NOT NULL"
        : "";
  const { results } = await db
    .prepare(
      `WITH threads AS (
         SELECT id FROM comments
         WHERE site_slug = ? AND thread_id IS NULL ${filter}
         ORDER BY created_at DESC LIMIT ${MAX_THREADS}
       )
       ${selectComments("comments.id IN (SELECT id FROM threads) OR comments.thread_id IN (SELECT id FROM threads)")}`,
    )
    .bind(slug)
    .all<CommentRow>();
  return toThreads(results);
}

async function getThread(db: D1Database, slug: string, id: string) {
  const { results } = await db
    .prepare(
      selectComments("comments.site_slug = ? AND (comments.id = ? OR comments.thread_id = ?)"),
    )
    .bind(slug, id, id)
    .all<CommentRow>();
  return toThreads(results)[0] ?? null;
}

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
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? null : trimmed;
}

/** The characters next to the quote. Longer context is cut, keeping the side next to it. */
function context(value: unknown, keep: "start" | "end") {
  if (typeof value !== "string") return "";
  return keep === "start" ? value.slice(0, MAX_CONTEXT) : value.slice(-MAX_CONTEXT);
}

function notFound() {
  return json({ error: "Comment not found" }, { status: 404, headers: noStore });
}
