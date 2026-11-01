import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { claimDraft, describeDraft } from "~/lib/drafts";
import { getIdentity, signedIn } from "~/lib/nap-server";
import { readJsonObject, requireJsonBody, requireSameSite } from "~/server/http";
import { route } from "~/server/route";

export const Route = createFileRoute("/api/drafts/$id")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            return yield* describeDraft(identity, params.id);
          }),
        ),
      POST: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            yield* requireJsonBody(request);
            const body = yield* readJsonObject(request);
            return yield* claimDraft(getIdentity(request), params.id, body);
          }),
        ),
    },
  },
});
