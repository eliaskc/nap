import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { decideDeviceRequest, describeDeviceRequest } from "~/lib/agent-auth";
import { signedIn } from "~/lib/nap-server";
import { readJsonObject, requireJsonBody, requireSameSite } from "~/server/http";
import { route } from "~/server/route";

/** The /connect page. GET shows an agent's sign-in request; POST approves or denies it. */
export const Route = createFileRoute("/api/connect/$code")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            yield* signedIn(request);
            return yield* describeDeviceRequest(params.code);
          }),
        ),
      POST: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            // Approving gives an agent a token for this person. Only this origin may ask: a JSON
            // body forces a CORS preflight, and naps on other hosts are same-site, not same-origin.
            yield* requireSameSite(request);
            yield* requireJsonBody(request);
            const identity = yield* signedIn(request);
            const body = yield* readJsonObject(request);
            return yield* decideDeviceRequest(identity, params.code, body.action);
          }),
        ),
    },
  },
});
