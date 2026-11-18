import { Effect } from "effect";
import { Database } from "~/server/database";
import { HttpError } from "~/server/http";

/**
 * How a nap is served. "artifact": in Nap's sandboxed frame at <root>/<name>, the default.
 * "site": on its own host, <name>.<root>, for the few naps that still need one. The values are
 * older than the word "nap" and stay in the database and the agent API.
 */
export type SiteKind = "site" | "artifact";

/** The title of a nap that has none. */
export const UNTITLED_NAP = "Untitled nap";

/**
 * The serving mode and the name of a new nap, from what an agent sent. Names come slugified.
 * - name: a chosen name: <root>/<name>, or <name>.<root> on its own host. Without one, the nap
 *   gets a random id (one made from the title on its own host).
 * - ownHost: true serves it on its own host. The default is Nap's frame.
 * - kind: the older way to say the same: "site" is its own host, "artifact" the frame.
 * - slug: the older name field. Without kind or ownHost it means its own host, as it always did,
 *   so agents and scripts written for it keep working.
 */
export function napShape(fields: {
  kind: string;
  ownHost: string | boolean | undefined;
  name: string;
  slug: string;
}): { kind: SiteKind; slug: string } | { error: string } {
  const { kind, name, slug } = fields;
  if (kind && kind !== "site" && kind !== "artifact") {
    return { error: 'kind must be "artifact" or "site"' };
  }
  const ownHost = parseBoolean(fields.ownHost);
  if (ownHost === "invalid") return { error: "ownHost must be true or false" };
  if (kind && ownHost !== undefined && (kind === "site") !== ownHost) {
    return { error: "kind and ownHost disagree. Send only ownHost." };
  }
  if (name && slug && name !== slug) return { error: "Send name or slug, not both" };
  const onOwnHost = ownHost ?? (kind ? kind === "site" : !name && Boolean(slug));
  return { kind: onOwnHost ? "site" : "artifact", slug: name || slug };
}

function parseBoolean(value: string | boolean | undefined) {
  if (value === undefined || value === "") return undefined;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return "invalid" as const;
}

/**
 * Uploads that pass through the Worker. It holds them in memory and writes each file to R2
 * itself, so keep these small.
 */
export const MAX_UPLOAD_FILES = 1_000;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/**
 * Direct uploads go from the client to R2 and never pass through the Worker. Nap signs their
 * URLs a page at a time, so the file count is bound only by the manifest Nap keeps in R2.
 */
export const MAX_DIRECT_UPLOAD_FILES = 100_000;
export const MAX_DIRECT_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
/** One file of a direct upload is one PUT, and R2 takes at most 5 GiB in one. */
export const MAX_DIRECT_FILE_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Names that Nap uses itself. No nap may take one: a nap's name is the first path segment on
 * the root domain (<root>/<name>), next to Nap's own routes, and the host label of a nap on its
 * own host (<name>.<root>). tests/reserved-names.test.mjs fails when a
 * top-level route is added without being listed here.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Host labels.
  "artifacts", // the old artifact host, artifacts.<root>, which redirects
  "www",
  "mcp",
  "admin",
  "static",
  // Top-level routes on the root domain: src/routes, src/worker.ts, the built assets.
  "api", // src/routes/api
  "app",
  "apps",
  "claim",
  "connect",
  "install",
  "requests",
  "s", // local sites, /s/<slug>/
  "a", // old local artifact links, /a/<id>
  "welcome",
  "_nap",
  "assets", // the dashboard's built JavaScript and CSS (dist/client/assets)
  "cdn-cgi", // Cloudflare's own paths, such as /cdn-cgi/access/logout
  "artifact", // old artifact links, /artifact/<id>, which redirect
  // Kept for later: what pages will be called.
  "nap",
  "naps",
]);

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
 * A nap without a chosen name gets a random id, never a title or a reserved name: <root>/<id>.
 * Lowercase [a-z0-9], so the id is still a valid host label if the owner moves the nap to its
 * own host.
 * 12 characters is about 62 bits: collisions are not a concern, and links are hard to guess.
 */
export const pickArtifactId = Effect.fnUntraced(function* <E, R>(
  isTaken: (id: string) => Effect.Effect<boolean, E, R>,
) {
  const next = () => {
    let id = newNapId(ARTIFACT_ID_LENGTH);
    while (isReservedSlug(id)) id = newNapId(ARTIFACT_ID_LENGTH);
    return id;
  };
  let id = next();
  for (let attempt = 0; attempt < 5 && (yield* isTaken(id)); attempt++) id = next();
  return id;
});

const TITLE_SLUG_MAX = 24;
const DEFAULT_TITLES = new Set(["untitled", "untitled-nap", "untitled-artifact", "untitled-site"]);

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
 * A fallback name for a nap on its own host without a chosen one: "<title>-<4 chars>", or 6 random characters
 * without a title.
 */
export function generatedSlug(title: string | null | undefined) {
  const base = titleSlug(title);
  return base ? `${base}-${newNapId(4)}` : newNapId(6);
}

/**
 * A name for a nap on its own host without a chosen one. First the plain title ("q3-report"),
 * then, if that is taken or reserved, the title with a random suffix. Generated names share the
 * one namespace with chosen names and random ids. Never take one in use.
 */
export const pickGeneratedSlug = Effect.fnUntraced(function* <E, R>(
  title: string | null | undefined,
  isTaken: (slug: string) => Effect.Effect<boolean, E, R>,
) {
  const base = titleSlug(title);
  if (base && !isReservedSlug(base) && !(yield* isTaken(base))) return base;
  const next = () => {
    let slug = generatedSlug(title);
    while (isReservedSlug(slug)) slug = generatedSlug(title);
    return slug;
  };
  let slug = next();
  for (let attempt = 0; attempt < 5 && (yield* isTaken(slug)); attempt++) slug = next();
  return slug;
});

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

const uploadError = (error: string, status: number) => new HttpError({ status, body: { error } });

/** Refuses a request body that says it is too large, before Nap reads it. */
export const rejectLargeBody = (request: Request) => {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  return declaredLength > MAX_UPLOAD_BYTES + 64 * 1024
    ? Effect.fail(
        uploadError(`Upload is larger than ${formatLimit(MAX_UPLOAD_BYTES)}. ${DIRECT_HINT}`, 413),
      )
    : Effect.void;
};

/**
 * Reads an upload from agents: one HTML file sent as text/html, or multipart form data with
 * `file` or `files` fields. Text fields come from the query string, and form fields override
 * them. A single HTML file becomes index.html.
 */
export const readUpload = Effect.fnUntraced(function* <Name extends string>(
  request: Request,
  url: URL,
  names: ReadonlyArray<Name>,
) {
  const contentType = request.headers.get("content-type") ?? "";
  const fields = Object.fromEntries(
    names.map((name) => [name, url.searchParams.get(name) ?? ""]),
  ) as Record<Name, string>;
  let files: Array<IncomingFile> = [];

  if (contentType.includes("multipart/form-data")) {
    const form = yield* Effect.promise(() => request.formData().catch(() => null));
    if (!form) return yield* Effect.fail(uploadError("Could not read form data", 400));
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
    const body = yield* Effect.tryPromise({
      try: () => request.blob(),
      catch: () => uploadError("Could not read the upload", 400),
    });
    files = [{ path: "index.html", body }];
  } else {
    return yield* Effect.fail(
      uploadError(
        "Send one HTML file with content-type text/html, or multipart/form-data with file fields",
        415,
      ),
    );
  }

  for (const name of names) fields[name] = fields[name].trim();
  return { files, fields };
});

/** The same checks for every upload path. Succeeds with the total size. */
export const checkFiles = (files: Array<IncomingFile>) =>
  checkManifest(
    files.map((file) => ({ path: file.path, size: file.body.size })),
    { maxFiles: MAX_UPLOAD_FILES, maxBytes: MAX_UPLOAD_BYTES },
  ).pipe(
    Effect.mapError((error) =>
      error.status === 413
        ? uploadError(`Upload is larger than ${formatLimit(MAX_UPLOAD_BYTES)}. ${DIRECT_HINT}`, 413)
        : error,
    ),
  );

const DIRECT_HINT = `Direct uploads take up to ${formatLimit(MAX_DIRECT_UPLOAD_BYTES)} and ${MAX_DIRECT_UPLOAD_FILES.toLocaleString("en")} files; see "Direct uploads" in GET /_nap/api/instructions/api.`;

/** Checks a list of paths and sizes, before or without the file contents. */
export const checkManifest = (
  files: Array<{ path: string; size: number }>,
  limits: { maxFiles: number; maxBytes: number; maxFileBytes?: number },
): Effect.Effect<{ totalBytes: number }, HttpError> => {
  const problem = manifestProblem(files, limits);
  return problem
    ? Effect.fail(problem)
    : Effect.succeed({ totalBytes: files.reduce((sum, file) => sum + file.size, 0) });
};

function manifestProblem(
  files: Array<{ path: string; size: number }>,
  {
    maxFiles,
    maxBytes,
    maxFileBytes,
  }: { maxFiles: number; maxBytes: number; maxFileBytes?: number },
) {
  if (files.length === 0) return uploadError("No files uploaded", 400);
  if (files.length > maxFiles) {
    return uploadError(
      maxFiles === MAX_UPLOAD_FILES
        ? `Too many files (max ${maxFiles.toLocaleString("en")}). ${DIRECT_HINT}`
        : `Too many files (max ${maxFiles.toLocaleString("en")})`,
      400,
    );
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
  const tooLarge = maxFileBytes ? files.find((file) => file.size > maxFileBytes) : undefined;
  if (tooLarge) {
    return uploadError(
      `${tooLarge.path} is larger than ${formatLimit(maxFileBytes!)}, the most for one file`,
      413,
    );
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > maxBytes) {
    return uploadError(`Upload is larger than ${formatLimit(maxBytes)}`, 413);
  }
  return null;
}

function formatLimit(bytes: number) {
  return bytes >= 1024 * 1024 * 1024
    ? `${bytes / 1024 / 1024 / 1024} GB`
    : `${bytes / 1024 / 1024} MB`;
}

export function randomTheme() {
  return { hue: Math.floor(Math.random() * 360) };
}

export const nextSortOrder = Effect.gen(function* () {
  const db = yield* Database;
  const maxSort = yield* db.first<{ maxSort: number }>(
    "SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM sites",
  );
  return (maxSort?.maxSort ?? 0) + 1000;
});
