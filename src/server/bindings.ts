import { Context } from "effect";
import type { AppSigner } from "~/lib/app-signer";
import type { SiteChannel } from "~/lib/site-channel";
import type { SiteLive } from "~/lib/site-live";

/**
 * Optional Worker bindings, as services. Each is null when the binding is missing (a stage
 * without it, or a test); the code that uses it answers 503.
 */

/**
 * The parts of the Artifacts binding Nap uses. workers-types lags behind the runtime here: a repo
 * handle has no metadata properties at runtime, only info().
 */
export type SourceCommit = { hash: string; parents: Array<string>; message?: string };
export type SourceRepo = {
  info(): Promise<{ name: string; remote: string; defaultBranch: string }>;
  createToken(
    scope?: "read" | "write",
    ttl?: number,
  ): Promise<{ plaintext: string; expiresAt: string }>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  log(options?: { ref?: string; limit?: number; offset?: number }): Promise<Array<SourceCommit>>;
  readCommit(hash: string): Promise<SourceCommit | null>;
  [Symbol.dispose]?: () => void;
};
export type SourceNamespace = {
  create(
    name: string,
    options?: { description?: string; setDefaultBranch?: string },
  ): Promise<{ name: string; remote: string; token: string }>;
  get(name: string): Promise<SourceRepo>;
  delete(name: string): Promise<boolean>;
};

/** SOURCES: the Artifacts namespace with one Git repo per site that keeps its source in Nap. */
export class SourceNamespaceBinding extends Context.Service<
  SourceNamespaceBinding,
  SourceNamespace | null
>()("nap/bindings/Sources") {}

/** LIVE: one Durable Object per site, holding the WebSockets for live collection updates. */
export class LiveBinding extends Context.Service<
  LiveBinding,
  DurableObjectNamespace<SiteLive> | null
>()("nap/bindings/Live") {}

/** CHANNELS: one Durable Object per site and channel name, for multiplayer pages. */
export class ChannelsBinding extends Context.Service<
  ChannelsBinding,
  DurableObjectNamespace<SiteChannel> | null
>()("nap/bindings/Channels") {}

/** The app signer: the SIGNER container, or locally a signer at NAP_SIGNER_URL. */
export class SignerBinding extends Context.Service<
  SignerBinding,
  { readonly url: string; readonly fetch: (request: Request) => Promise<Response> } | null
>()("nap/bindings/Signer") {
  static make(
    container: DurableObjectNamespace<AppSigner> | undefined,
    signerUrl: string | null,
  ): SignerBinding["Service"] {
    if (signerUrl) return { url: signerUrl, fetch: (request) => fetch(request) };
    if (!container) return null;
    return {
      url: "http://signer",
      // getContainer(container, "signer") from @cloudflare/containers, which does not load
      // outside workerd.
      fetch: (request) => container.get(container.idFromName("signer")).fetch(request),
    };
  }
}
