import { Effect, Schema } from "effect";
import type {
  NapExtension,
  NapExtensionCache,
  NapExtensionContext,
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
 */
export const handleExtensionRequest = Effect.fn("handleExtensionRequest")(function* (
  extensions: ReadonlyArray<ExtensionEntry>,
  slug: string,
  request: Request,
  identity: Identity,
  path: string,
  options: { frame?: boolean } = {},
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
    viewer: { email: identity.email, name: identity.name },
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

/** An extension's cache: one object per key below extension-cache/<name>/, by the key's hash. */
function extensionCache(storage: Storage["Service"], name: string): NapExtensionCache {
  const objectKey = async (key: string) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
    return `${EXTENSION_CACHE_PREFIX}${name}/${hex.join("")}`;
  };
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
  };
}

/** One JSON line in the Worker's logs, which Workers Logs indexes. */
function log(extension: string, message: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level: "INFO", message, extension, ...fields }));
}

/** Nap's client types with each extension's types.d.ts after them. */
export function clientTypesWithExtensions(
  base: string,
  extensions: ReadonlyArray<ExtensionEntry>,
) {
  const added = extensions
    .filter((extension) => extension.types)
    .map((extension) => `\n// nap.${extension.name}\n\n${extension.types!.trim()}\n`);
  return base + added.join("");
}
