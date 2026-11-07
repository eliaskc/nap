import type { NapWorkerEnv } from "../alchemy.run";

declare global {
  namespace Cloudflare {
    interface Env extends NapWorkerEnv {}
  }
}

declare global {
  /** A hash of the icons this build serves (vite.config.ts), for their URLs. */
  const __NAP_ICON_VERSION__: string;
}
