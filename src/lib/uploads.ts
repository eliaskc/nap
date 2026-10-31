/** Artifacts: quick pages, shared by link, only in the owner's Artifacts list. Sites: everything else. */
export type SiteKind = "site" | "artifact";

export const MAX_UPLOAD_FILES = 1_000;
/** Uploads that pass through the Worker. It holds them in memory, so keep this small. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Direct uploads go from the client to R2 and never pass through the Worker. */
export const MAX_DIRECT_UPLOAD_BYTES = 1024 * 1024 * 1024;

// Host labels that Nap uses itself. No site may take them.
const RESERVED_SLUGS = new Set(["artifacts", "www", "api", "mcp", "admin", "static"]);

export function isReservedSlug(slug: string) {
  return RESERVED_SLUGS.has(slug);
}

/**
 * Random [a-z0-9] characters: safe as a DNS label. Cloudflare Access protects every host, so
 * ids only need to be unique, not hard to guess. Callers check for collisions.
 */
export function newNapId(length = 6) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

const ARTIFACT_ID_LENGTH = 12;

/**
 * An artifact's URL is <root>/artifact/<id>, with a random id and never a title. Lowercase
 * [a-z0-9], so the id is still a valid host label if the owner moves the artifact to Sites.
 * 12 characters is about 62 bits: collisions are not a concern, and links are hard to guess.
 */
export async function pickArtifactId(isTaken: (id: string) => Promise<boolean>) {
  let id = newNapId(ARTIFACT_ID_LENGTH);
  for (let attempt = 0; attempt < 5 && (isReservedSlug(id) || (await isTaken(id))); attempt++) {
    id = newNapId(ARTIFACT_ID_LENGTH);
  }
  return id;
}

const TITLE_SLUG_MAX = 24;
const DEFAULT_TITLES = new Set(["untitled", "untitled-artifact", "untitled-site"]);

/** "Sleep report: Q3 (draft)" -> "sleep-report-q3-draft". Empty for default titles. */
export function titleSlug(title: string | null | undefined) {
  const slug = (title ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (DEFAULT_TITLES.has(slug)) return "";
  if (slug.length <= TITLE_SLUG_MAX) return slug;
  // Cut at a word boundary when one is near enough.
  const cut = slug.slice(0, TITLE_SLUG_MAX + 1);
  const lastHyphen = cut.lastIndexOf("-");
  return (lastHyphen >= 8 ? cut.slice(0, lastHyphen) : cut.slice(0, TITLE_SLUG_MAX)).replace(
    /-+$/,
    "",
  );
}

/**
 * A fallback URL for a nap without a chosen slug: "<title>-<4 chars>", or 6 random characters
 * without a title.
 */
export function generatedSlug(title: string | null | undefined) {
  const base = titleSlug(title);
  return base ? `${base}-${newNapId(4)}` : newNapId(6);
}

/**
 * A URL for a nap without a chosen slug. First the plain title ("q3-report"), then, if that is
 * taken or reserved, the title with a random suffix. Generated slugs share the host namespace
 * with chosen slugs. Never take one in use.
 */
export async function pickGeneratedSlug(
  title: string | null | undefined,
  isTaken: (slug: string) => Promise<boolean>,
) {
  const base = titleSlug(title);
  if (base && !isReservedSlug(base) && !(await isTaken(base))) return base;
  let slug = generatedSlug(title);
  for (let attempt = 0; attempt < 5 && (await isTaken(slug)); attempt++) {
    slug = generatedSlug(title);
  }
  return slug;
}

export function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

export function isSafePath(path: string) {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.split("/").some((segment) => segment === ".." || segment === "") &&
    !path.includes("\0")
  );
}

export function contentTypeForPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json; charset=utf-8";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".woff2")) return "font/woff2";
  if (lower.endsWith(".woff")) return "font/woff";
  if (lower.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

export type IncomingFile = { path: string; body: Blob };

const UPLOAD_ERROR_HEADERS = { "content-type": "application/json; charset=utf-8" };

function uploadError(error: string, status: number) {
  return new Response(JSON.stringify({ error }), { status, headers: UPLOAD_ERROR_HEADERS });
}

/** Refuses a request body that says it is too large, before Nap reads it. */
export function rejectLargeBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_UPLOAD_BYTES + 64 * 1024) {
    return uploadError(
      `Upload is larger than ${formatLimit(MAX_UPLOAD_BYTES)}. ${DIRECT_HINT}`,
      413,
    );
  }
  return null;
}

/**
 * Reads an upload from agents: one HTML file sent as text/html, or multipart form data with
 * `file` or `files` fields. Text fields come from the query string, and form fields override
 * them. A single HTML file becomes index.html.
 */
export async function readUpload<Name extends string>(
  request: Request,
  url: URL,
  names: ReadonlyArray<Name>,
): Promise<Response | { files: Array<IncomingFile>; fields: Record<Name, string> }> {
  const contentType = request.headers.get("content-type") ?? "";
  const fields = Object.fromEntries(
    names.map((name) => [name, url.searchParams.get(name) ?? ""]),
  ) as Record<Name, string>;
  let files: Array<IncomingFile> = [];

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (!form) return uploadError("Could not read form data", 400);
    for (const name of names) {
      const value = form.get(name);
      if (typeof value === "string") fields[name] = value;
    }
    const uploaded = [...form.getAll("file"), ...form.getAll("files")].filter(
      (value): value is File => value instanceof File,
    );
    files = uploaded.map((file) => ({ path: normalizePath(file.name), body: file }));
    if (files.length === 1 && /\.html?$/i.test(files[0].path)) files[0].path = "index.html";
  } else if (contentType.includes("text/html")) {
    files = [{ path: "index.html", body: await request.blob() }];
  } else {
    return uploadError(
      "Send one HTML file with content-type text/html, or multipart/form-data with file fields",
      415,
    );
  }

  for (const name of names) fields[name] = fields[name].trim();
  return { files, fields };
}

/** The same checks for every upload path. Returns an error response, or the total size. */
export function checkFiles(files: Array<IncomingFile>): Response | { totalBytes: number } {
  const checked = checkManifest(
    files.map((file) => ({ path: file.path, size: file.body.size })),
    MAX_UPLOAD_BYTES,
  );
  if (checked instanceof Response && checked.status === 413) {
    return uploadError(
      `Upload is larger than ${formatLimit(MAX_UPLOAD_BYTES)}. ${DIRECT_HINT}`,
      413,
    );
  }
  return checked;
}

const DIRECT_HINT = `Direct uploads take up to ${formatLimit(MAX_DIRECT_UPLOAD_BYTES)}; see "Direct uploads" in GET /_nap/api/instructions/api.`;

/** Checks a list of paths and sizes, before or without the file contents. */
export function checkManifest(
  files: Array<{ path: string; size: number }>,
  maxBytes: number,
): Response | { totalBytes: number } {
  if (files.length === 0) return uploadError("No files uploaded", 400);
  if (files.length > MAX_UPLOAD_FILES) {
    return uploadError(`Too many files (max ${MAX_UPLOAD_FILES})`, 400);
  }
  const unsafe = files.find((file) => !isSafePath(file.path));
  if (unsafe) return uploadError(`Unsafe file path: ${unsafe.path}`, 400);
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    return uploadError("Duplicate file paths", 400);
  }
  if (!files.some((file) => file.path === "index.html")) {
    return uploadError("Upload must contain a root index.html", 400);
  }
  const badSize = files.find((file) => !Number.isSafeInteger(file.size) || file.size < 0);
  if (badSize) return uploadError(`Bad file size: ${badSize.path}`, 400);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > maxBytes) {
    return uploadError(`Upload is larger than ${formatLimit(maxBytes)}`, 413);
  }
  return { totalBytes };
}

function formatLimit(bytes: number) {
  return bytes >= 1024 * 1024 * 1024
    ? `${bytes / 1024 / 1024 / 1024} GB`
    : `${bytes / 1024 / 1024} MB`;
}

export function randomTheme() {
  return { hue: Math.floor(Math.random() * 360) };
}

export async function nextSortOrder(db: D1Database) {
  const maxSort = await db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM sites")
    .first<{ maxSort: number }>();
  return (maxSort?.maxSort ?? 0) + 1000;
}
