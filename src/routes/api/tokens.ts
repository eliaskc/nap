import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { ACTIVE_DAYS, listAgentTokens } from "~/lib/agent-auth";
import { signedIn } from "~/lib/nap-server";
import { json, noStore } from "~/server/http";
import { route } from "~/server/route";

/** GET /api/tokens — the caller's connected agents. */
export const Route = createFileRoute("/api/tokens")({
  server: {
    handlers: {
      GET: ({ request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const tokens = yield* listAgentTokens(identity.email);
            return json({ tokens, activeDays: ACTIVE_DAYS }, { headers: noStore });
          }),
        ),
    },
  },
});
