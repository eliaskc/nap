declare module "virtual:nap-comments-frame" {
  /** The comments script for inside artifact frames, bundled from src/comments/frame.ts. */
  const source: string;
  export default source;
}

declare module "virtual:nap-client" {
  /** window.nap, bundled from src/client/index.ts. */
  const source: string;
  export default source;
}
