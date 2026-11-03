declare module "virtual:nap-comments-frame" {
  /** The comments script for inside artifact frames, bundled from src/comments/frame.ts. */
  const source: string;
  export default source;
}

declare module "virtual:nap-client" {
  /** window.nap, bundled from src/client/index.ts: /_nap/client.js. */
  export const client: string;
  /** The voice engine, bundled from src/client/voice-engine.ts: /_nap/client-voice.js. */
  export const voice: string;
  /** A hash of the voice engine, which client.js asks for as ?v=. */
  export const voiceVersion: string;
}

declare module "virtual:nap-extensions" {
  import type { NapExtension } from "../nap.extension.ts";
  /** The deployment's extensions, from instance/extensions (see nap.extension.ts). */
  export const extensions: ReadonlyArray<{
    name: string;
    server: NapExtension;
    /** types.d.ts, added to /_nap/client.d.ts. */
    types: string | null;
    /** instructions.md, the topic <name>. */
    instructions: string | null;
  }>;
}

declare module "virtual:nap-extensions-client" {
  import type { NapExtensionClient } from "../nap.extension.ts";
  /** [name, client.ts] for each extension with a client: nap.<name>. */
  export const extensions: ReadonlyArray<readonly [string, NapExtensionClient]>;
}
