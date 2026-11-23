import { Effect, Schema } from "effect";
import type {
  NapExtension,
  NapExtensionCache,
  NapExtensionContext,
  NapGroups,
} from "../../nap.extension.ts";
import type { Identity } from "~/lib/nap-server";
import { canViewSite } from "~/lib/site-data";
import { Database } from "~/server/database";
import { failNoStore, isCrossSite } from "~/server/http";
import { Background, Settings } from "~/server/platform";
import { Storage } from "~/server/storage";

/** Where extension caches live in the bucket. A lifecycle rule deletes entries after a week. */
export const EXTENSION_CACHE_PREFIX = "extension-cache/";

/** One of the deployment's extensions (see nap.extension.ts and virtual:nap-extensions). */
export type ExtensionEntry = {
  name: string;
  server: NapExtension;
  types: string | null;
  instructions: string | null;
};

/** The extension threw, or its promise rejected. It becomes a 500 for the page. */
export class ExtensionError extends Schema.TaggedError<ExtensionError>()("ExtensionError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * /_nap/ext/<name>/<path> for a page: on its site's host, below an artifact's frame token
 * (`frame: true`), or on a local dev server. Nap checks that the person can view the page and
 * hands the request to the extension with its secrets. Sites refuse cross-site requests, as
 * nap.fetch does; frames are cross-site by nature, and their token is the credential.
 * `groups` are the deployment's (GROUPS); the extension hears which the viewer is in.
 */
export const handleExtensionRequest = Effect.fn("handleExtensionRequest")(function* (
  extensions: ReadonlyArray<ExtensionEntry>,
  slug: string,
  request: Request,
  identity: Identity,
  path: string,
  options: { frame?: boolean; groups?: NapGroups } = {},
) {
  const slash = path.indexOf("/");
  const name = slash === -1 ? path : path.slice(0, slash);
  const rest = slash === -1 ? "" : path.slice(slash + 1);
  const extension = extensions.find((entry) => entry.name === name);
  if (!extension) return yield* failNoStore(404, `nap.${name} is not on this Nap`);
  if (!options.frame && isCrossSite(request)) return yield* failNoStore(403, "Forbidden");

  const db = yield* Database;
  const site = yield* db.first<{ kind: string }>(`SELECT kind FROM sites WHERE slug = ?`, slug);
  const kind = site?.kind === "artifact" ? "artifact" : site?.kind === "site" ? "site" : null;
  if (!kind || (options.frame && kind !== "artifact")) {
    return yield* failNoStore(404, "Page not found");
  }
  if (!(yield* canViewSite(slug, identity.email))) return yield* failNoStore(403, "Forbidden");

  const { extensionSecrets } = yield* Settings;
  const secrets: Record<string, string | undefined> = {};
  for (const secret of extension.server.secrets ?? []) secrets[secret] = extensionSecrets[secret];

  // Without the request's waitUntil (tests), background work finishes before the response.
  const { waitUntil } = yield* Background;
  const pending: Array<Promise<unknown>> = [];
  const context: NapExtensionContext = {
    path: rest,
    page: { slug, kind },
    viewer: {
      email: identity.email,
      name: identity.name,
      groups: groupsOf(options.groups ?? {}, identity.email),
    },
    secrets,
    cache: extensionCache(yield* Storage, name),
    waitUntil: (promise) => {
      const logged = promise.catch((error) =>
        log(name, "Background work failed", { error: String(error) }),
      );
      if (waitUntil) waitUntil(logged);
      else pending.push(logged);
    },
    log: (message, fields) => log(name, message, fields),
  };

  const response = yield* Effect.tryPromise({
    try: () => extension.server.handle(request, context),
    catch: (cause) =>
      new ExtensionError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(
    Effect.catchTag("ExtensionError", (error) =>
      Effect.logError(`nap.${name} failed`, error).pipe(
        Effect.andThen(failNoStore(500, `nap.${name} failed`)),
      ),
    ),
  );
  if (pending.length) yield* Effect.promise(() => Promise.all(pending));

  const headers = new Headers(response.headers);
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
});

/** The groups this person is in, sorted. Emails match whatever their case. */
export function groupsOf(groups: NapGroups, email: string): Array<string> {
  const wanted = email.trim().toLowerCase();
  return Object.entries(groups)
    .filter(
      ([, emails]) =>
        Array.isArray(emails) &&
        emails.some(
          (member) => typeof member === "string" && member.trim().toLowerCase() === wanted,
        ),
    )
    .map(([name]) => name)
    .sort();
}

/**
 * An extension's cache: one object per key below extension-cache/<name>/, by the key's hash, and
 * claims below extension-cache/<name>/claims/.
 */
function extensionCache(storage: Storage["Service"], name: string): NapExtensionCache {
  const hash = async (key: string) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  };
  const objectKey = async (key: string) => `${EXTENSION_CACHE_PREFIX}${name}/${await hash(key)}`;
  const claimKey = async (key: string) =>
    `${EXTENSION_CACHE_PREFIX}${name}/claims/${await hash(key)}`;
  return {
    async get(key) {
      const object = await Effect.runPromise(storage.get(await objectKey(key)));
      if (!object) return null;
      return { value: await object.text(), storedAt: object.uploaded };
    },
    async put(key, value) {
      await Effect.runPromise(
        storage.put(await objectKey(key), value, {
          httpMetadata: { contentType: "application/json" },
        }),
      );
    },
    // A claim is an object whose upload time says when it was taken. Taking one over replaces it
    // only if it is still the object this caller saw (its etag; the content is unique, so every
    // claim has its own), so of two servers at once, one wins. R2 is strongly consistent. The very
    // first claim of a key (or the first after the bucket's lifecycle rule deleted it) is not
    // conditional, so two servers may both get that one.
    async claim(key, seconds) {
      const objectKey = await claimKey(key);
      const current = await Effect.runPromise(storage.head(objectKey));
      if (current && Date.now() - current.uploaded.getTime() < seconds * 1000) return false;
      const taken = await Effect.runPromise(
        storage.put(
          objectKey,
          crypto.randomUUID(),
          current ? { onlyIf: { etagMatches: current.etag } } : undefined,
        ),
      );
      return taken !== null;
    },
  };
}

/** One JSON line in the Worker's logs, which Workers Logs indexes. */
function log(extension: string, message: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level: "INFO", message, extension, ...fields }));
}

/** Nap's client types with each extension's types.d.ts after them. */
export function clientTypesWithExtensions(base: string, extensions: ReadonlyArray<ExtensionEntry>) {
  const added = extensions
    .filter((extension) => extension.types)
    .map((extension) => `\n// nap.${extension.name}\n\n${extension.types!.trim()}\n`);
  return base + added.join("");
}
