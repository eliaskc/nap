import { Effect } from "effect";
import { ensureProfile, getIdentity, type Identity } from "~/lib/nap-server";
import { presignGet } from "~/lib/r2-presign";
import { canViewSite, readLimited } from "~/lib/site-data";
import { SLUG_PATTERN } from "~/lib/site-manifest";
import { fail, isCrossSite, json } from "~/server/http";
import { RateLimiter, Settings } from "~/server/platform";
import { Storage } from "~/server/storage";

/**
 * Files of a site (nap.files): photos and other blobs its pages and apps upload, up to 15 MB
 * each. They live in R2 at files/<slug>/<id>, with their type, name, uploader, and time as the
 * object's metadata; nothing is in D1. Who can read and write them follows who can view the
 * site, like its collections. Ids are random, and a file never changes: a new photo is a new file.
 *
 * - On the site's host: POST /_nap/files (the raw file as the body, its content-type, and an
 *   optional x-nap-file-name, percent-encoded), GET|HEAD|DELETE /_nap/files/<id>.
 * - With a token (apps, agents): /_nap/api/naps/<slug>/blobs[/<id>], the same calls.
 */

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_NAME_LENGTH = 120;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 24;
export const FILE_ID_PATTERN = /^[a-z0-9]{24}$/;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
/** How long a notification's image URL works: the longest a presigned R2 URL can. */
export const IMAGE_URL_SECONDS = 7 * 24 * 60 * 60;

export const fileKey = (slug: string, id: string) => `files/${slug}/${id}`;
export const filesPrefix = (slug: string) => `files/${slug}/`;

export type NapFile = {
  id: string;
  type: string;
  size: number;
  name: string | null;
  createdBy: string;
  createdAt: string;
};

function newFileId() {
  let id = "";
  while (id.length < ID_LENGTH) {
    // Bytes below 252 (7 × 36) map evenly onto the alphabet; the rest are skipped.
    for (const byte of crypto.getRandomValues(new Uint8Array(ID_LENGTH * 2))) {
      if (byte < 252 && id.length < ID_LENGTH) id += ID_ALPHABET[byte % ID_ALPHABET.length];
    }
  }
  return id;
}

/** The file's name from x-nap-file-name: percent-encoded UTF-8, or plain ASCII. */
function readName(value: string | null) {
  if (!value) return null;
  let name = value;
  try {
    name = decodeURIComponent(value);
  } catch {}
  // No paths or control characters: only what a download would call it.
  name = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[\\/]/)
    .pop()!
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return name || null;
}

function readType(value: string | null) {
  const type = (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (!type) return "application/octet-stream";
  return CONTENT_TYPE_PATTERN.test(type) ? type : null;
}

function toFile(id: string, object: R2Object): NapFile {
  const meta = object.customMetadata ?? {};
  let name: string | null = null;
  if (meta.name) {
    try {
      name = decodeURIComponent(meta.name);
    } catch {
      name = meta.name;
    }
  }
  return {
    id,
    type: object.httpMetadata?.contentType ?? "application/octet-stream",
    size: object.size,
    name,
    createdBy: meta.createdBy ?? "",
    createdAt: meta.createdAt ?? object.uploaded.toISOString(),
  };
}

/** Headers for serving a file: its type, and never run as a page on the site's origin. */
function fileHeaders(file: NapFile, object: R2Object) {
  const headers = new Headers({
    "content-type": file.type,
    "content-length": String(object.size),
    "cache-control": "private, max-age=31536000, immutable",
    etag: object.httpEtag,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
  });
  if (file.name) {
    headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  }
  return headers;
}

/**
 * /_nap/files[/<id>] for a site. `path` is "" or the id. `identity` is set for requests that
 * Access does not protect (frames and tokens): the person from the token, and the request does
 * not count as using Nap.
 */
export const handleSiteFilesRequest = Effect.fn("handleSiteFilesRequest")(function* (
  slug: string,
  request: Request,
  path: string,
  options: { identity?: Identity } = {},
) {
  const identity = options.identity ?? getIdentity(request);
  if (!SLUG_PATTERN.test(slug) || !(yield* canViewSite(slug, identity.email))) {
    return yield* fail(404, "Site not found");
  }
  if (!options.identity) yield* ensureProfile(identity);
  const method = request.method;
  // Forms need no preflight: on the site's own host, writes only from its own pages.
  if (!options.identity && method !== "GET" && method !== "HEAD" && isCrossSite(request)) {
    return yield* fail(403, "Forbidden");
  }
  const storage = yield* Storage;
  const id = path.replace(/^\/+|\/+$/g, "");

  if (!id) {
    if (method !== "POST") return yield* fail(405, "Method not allowed", {}, { allow: "POST" });
    const type = readType(request.headers.get("content-type"));
    if (!type) return yield* fail(400, "Give the file's content-type, such as image/jpeg");
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
      return yield* fail(413, "Files can be up to 15 MB");
    }
    const limiter = yield* RateLimiter;
    if (!(yield* limiter.allow(`files:${identity.email.toLowerCase()}`))) {
      return yield* fail(429, "Too many uploads. Wait a minute.");
    }
    const reader = request.body?.getReader();
    const bytes = reader ? yield* Effect.promise(() => readLimited(reader, MAX_FILE_BYTES)) : null;
    if (reader && !bytes) return yield* fail(413, "Files can be up to 15 MB");
    if (!bytes || bytes.byteLength === 0) return yield* fail(400, "Send the file as the body");
    const name = readName(request.headers.get("x-nap-file-name"));
    const fileId = newFileId();
    const createdAt = new Date().toISOString();
    const stored = yield* storage.put(fileKey(slug, fileId), bytes, {
      httpMetadata: { contentType: type },
      customMetadata: {
        ...(name ? { name: encodeURIComponent(name) } : {}),
        createdBy: identity.email,
        createdAt,
      },
    });
    const file: NapFile = {
      id: fileId,
      type,
      size: stored?.size ?? bytes.byteLength,
      name,
      createdBy: identity.email,
      createdAt,
    };
    yield* Effect.logInfo("File uploaded").pipe(
      Effect.annotateLogs({ slug, id: fileId, size: file.size, type, email: identity.email }),
    );
    return json({ file }, { status: 201, headers: { "cache-control": "no-store" } });
  }

  if (!FILE_ID_PATTERN.test(id)) return yield* fail(404, "File not found");
  const key = fileKey(slug, id);

  if (method === "GET" || method === "HEAD") {
    if (method === "HEAD") {
      const object = yield* storage.head(key);
      if (!object) return yield* fail(404, "File not found");
      return new Response(null, { headers: fileHeaders(toFile(id, object), object) });
    }
    const object = yield* storage.get(key);
    if (!object) return yield* fail(404, "File not found");
    const headers = fileHeaders(toFile(id, object), object);
    if (request.headers.get("if-none-match") === object.httpEtag) {
      yield* Effect.promise(() => object.body.cancel());
      return new Response(null, { status: 304, headers });
    }
    return new Response(object.body, { headers });
  }

  if (method === "DELETE") {
    const object = yield* storage.head(key);
    if (!object) return yield* fail(404, "File not found");
    yield* storage.delete(key);
    yield* Effect.logInfo("File deleted").pipe(
      Effect.annotateLogs({ slug, id, email: identity.email }),
    );
    return new Response(null, { status: 204 });
  }

  return yield* fail(405, "Method not allowed", {}, { allow: "GET, HEAD, DELETE" });
});

/**
 * A URL anyone can fetch for an image file of a site, for a notification: presigned R2 that
 * works for 7 days. On a local stage without R2 signing, the local dev URL (no Access there);
 * elsewhere without it, null. Fails with 400 when the id is not an image file of the site.
 */
export const notificationImageUrl = Effect.fn("notificationImageUrl")(function* (
  slug: string,
  id: string,
  localOrigin: string | null,
) {
  const problem = `image must be the id of an image file of this site (nap.files.upload)`;
  if (!FILE_ID_PATTERN.test(id)) return yield* fail(400, problem);
  const storage = yield* Storage;
  const object = yield* storage.head(fileKey(slug, id));
  if (!object) return yield* fail(400, problem);
  if (!(object.httpMetadata?.contentType ?? "").startsWith("image/")) {
    return yield* fail(400, problem);
  }
  const { r2 } = yield* Settings;
  if (r2) return yield* presignGet(r2, fileKey(slug, id), IMAGE_URL_SECONDS);
  if (localOrigin) return `${localOrigin}/s/${slug}/_nap/files/${id}`;
  yield* Effect.logWarning("Notification image left out: R2 signing is not set up");
  return null;
});

/** Deletes every file of a site, such as when the site is deleted. */
export const deleteSiteFiles = Effect.fn("deleteSiteFiles")(function* (slug: string) {
  const storage = yield* Storage;
  const keys = (yield* storage.list(filesPrefix(slug))).map((item) => item.key);
  for (let i = 0; i < keys.length; i += 1000) yield* storage.delete(keys.slice(i, i + 1000));
  return keys.length;
});
