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
