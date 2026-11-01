import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { revokeAgentToken } from "~/lib/agent-auth";
import { signedIn } from "~/lib/nap-server";
import { requireSameSite } from "~/server/http";
import { route } from "~/server/route";

/** DELETE /api/tokens/:id — disconnects one of the caller's agents. */
export const Route = createFileRoute("/api/tokens/$id")({
  server: {
    handlers: {
      DELETE: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            const identity = yield* signedIn(request);
            return yield* revokeAgentToken(identity.email, params.id);
          }),
        ),
    },
  },
});
