import { env } from "cloudflare:workers";
import type { Effect } from "effect";
import { respond, type NapEnv, type NapServices } from "~/server/runtime";

/**
 * Runs an Effect handler for a TanStack API route (src/routes/api). The route has no
 * ExecutionContext, so background work runs before the response.
 */
export function route<E>(handler: Effect.Effect<Response, E, NapServices>) {
  return respond(env as unknown as NapEnv, handler);
}
