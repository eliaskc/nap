import type { NapWorkerEnv } from "../alchemy.run";

declare global {
  namespace Cloudflare {
    interface Env extends NapWorkerEnv {}
  }
}
