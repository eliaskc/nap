/**
 * Extensions add an API to the kit that pages get, for one Nap deployment, without changing Nap
 * itself. Each lives in instance/extensions/<name>/ of the deployment:
 *
 *   server.ts        `export default { ... } satisfies NapExtension`: handles /_nap/ext/<name>/...
 *   client.ts        `export default ((kit) => ({ ... })) satisfies NapExtensionClient`: what
 *                    pages get as nap.<name> (optional)
 *   types.d.ts       its types, added to /_nap/client.d.ts (optional)
 *   instructions.md  the agent instructions topic <name>, listed in the index (optional)
 *   client.swift     what iOS apps get, for NapKit: an `extension NapSite` with a property
 *                    <name> built on `extensionKit("<name>")`, so apps call site.<name>
 *                    (optional). New app repos get it; `scripts/napkit` updates existing ones.
 *
 * The name is the folder's: lowercase letters and digits, starting with a letter, and not one of
 * window.nap's own names. Nap bundles extensions at build time. They are plain TypeScript with no
 * dependencies of their own, and import nothing from Nap but these types (`import type`), because
 * instance/ is copied in or linked at build time.
 *
 * Nap checks that the person can view the page before it calls the extension, on sites, in
 * artifact frames, and on local dev servers. Secrets come from the deployment: the JSON object in
 * NAP_EXTENSION_SECRETS (a GitHub secret of the config repository), and each extension gets only
 * the names it declares. Pages never see them.
 */

export type NapExtension = {
  /** One line for the instructions index: what the API does, such as "Amplitude analytics". */
  summary: string;
  /** Names of the secrets the extension reads from NAP_EXTENSION_SECRETS. */
  secrets?: ReadonlyArray<string>;
  /**
   * Answers a page's request to /_nap/ext/<name>/<path>. Errors should be JSON `{ "error" }` with
   * a fitting status, which the client kit turns into a NapError. A thrown error becomes a 500.
   */
  handle(request: Request, context: NapExtensionContext): Promise<Response>;
};

export type NapExtensionContext = {
  /** The path below /_nap/ext/<name>/, without the leading slash. */
  path: string;
  /** The page that asked. */
  page: { slug: string; kind: "site" | "artifact" };
  /** The person viewing the page. Nap has checked that they can view it. */
  viewer: { email: string; name: string };
  /** The extension's declared secrets. A secret the deployment does not set is missing. */
  secrets: Readonly<Record<string, string | undefined>>;
  /** Values the extension keeps between requests, shared by every page and viewer. */
  cache: NapExtensionCache;
  /** Keeps work going after the response, such as writing to the cache. */
  waitUntil(promise: Promise<unknown>): void;
  /** Writes one JSON line to the Worker's logs. Never log secrets. */
  log(message: string, fields?: Record<string, unknown>): void;
};

/**
 * A store for the extension's own cache, in Nap's bucket. It is global and private to the
 * extension. Entries go away a week after they were stored; the extension decides how old is
 * too old by `storedAt`. (The Workers Cache API does not work behind Cloudflare Access.)
 */
export type NapExtensionCache = {
  /** The value stored under this key, with when it was stored, or null. */
  get(key: string): Promise<{ value: string; storedAt: Date } | null>;
  /** Stores a value under this key, replacing what was there. */
  put(key: string, value: string): Promise<void>;
};

/** What client.ts gets to build nap.<name> with. */
export type NapExtensionKit = {
  /** fetch() for /_nap/ext/<name>/<path>, wherever the page runs: a site, an artifact, local dev. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** request(), then the JSON body. Error statuses throw a NapError with the body's `error`. */
  json<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  NapError: new (message: string, status: number) => Error & { status: number };
};

/** The default export of client.ts. */
export type NapExtensionClient = (kit: NapExtensionKit) => object;
