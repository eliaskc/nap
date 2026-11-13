import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import {
  decideAccessRequest,
  describeAccessRequest,
  isAccessDecision,
} from "~/lib/access-requests";
import { signedIn } from "~/lib/nap-server";
import { isLocalHostname, type NapPlace } from "~/lib/nap-urls";
import {
  fail,
  json,
  noStore,
  readJsonObject,
  requireJsonBody,
  requireSameSite,
} from "~/server/http";
import { Settings } from "~/server/platform";
import { route } from "~/server/route";

const placeOf = (request: Request) =>
  Effect.gen(function* () {
    const { rootDomain } = yield* Settings;
    const url = new URL(request.url);
    return {
      rootDomain,
      localOrigin: isLocalHostname(url.hostname) ? url.origin : null,
    } satisfies NapPlace;
  });

/** The /requests/<id> page. GET shows an access request to its owner; POST answers it. */
export const Route = createFileRoute("/api/access-requests/$id")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const info = yield* describeAccessRequest(
              identity.email,
              params.id,
              yield* placeOf(request),
            );
            return json({ request: info }, { headers: noStore });
          }),
        ),
      POST: ({ params, request }) =>
        route(
          Effect.gen(function* () {
            // Answering changes who can open a nap. Only this origin may ask.
            yield* requireSameSite(request);
            yield* requireJsonBody(request);
            const identity = yield* signedIn(request);
            const body = yield* readJsonObject(request);
            if (!isAccessDecision(body.decision)) {
              return yield* fail(400, "decision must be add, everyone, or deny");
            }
            const result = yield* decideAccessRequest(
              identity.email,
              params.id,
              body.decision,
              yield* placeOf(request),
            );
            return json({ request: result.request }, { headers: noStore });
          }),
        ),
    },
  },
});
