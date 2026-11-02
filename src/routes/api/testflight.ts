import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { AppleError } from "~/lib/apple";
import { testFlightConfig } from "~/lib/apps";
import { signedIn } from "~/lib/nap-server";
import { forgetInvite, installStatus, requestInvite } from "~/lib/testflight-testers";
import {
  failNoStore,
  json,
  noStore,
  readJsonObject,
  requireSameSite,
  stringField,
} from "~/server/http";
import { route } from "~/server/route";

/** Apple's errors are shown to the person: they say what to fix. */
const appleFailure = <A, E, R>(effect: Effect.Effect<A, E | AppleError, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is AppleError => error instanceof AppleError,
      (error) => failNoStore(502, error.message),
    ),
  );

/**
 * The dashboard's Get the app, for the TestFlight launcher.
 * GET /api/testflight — where the caller is: not asked, invited to the team, or a tester.
 * POST /api/testflight { email } — asks Apple to invite that Apple Account email.
 * DELETE /api/testflight — starts over, to use another email.
 * { enabled: false } when TestFlight is off.
 */
export const Route = createFileRoute("/api/testflight")({
  server: {
    handlers: {
      GET: ({ request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            if (!testFlightConfig()) return json({ enabled: false }, { headers: noStore });
            const status = yield* appleFailure(installStatus(identity));
            return json(status, { headers: noStore });
          }),
        ),
      POST: ({ request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            const identity = yield* signedIn(request);
            if (!testFlightConfig()) return yield* failNoStore(404, "Not found");
            const body = yield* readJsonObject(request);
            const status = yield* appleFailure(requestInvite(identity, stringField(body.email)));
            return json(status, { headers: noStore });
          }),
        ),
      DELETE: ({ request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            const identity = yield* signedIn(request);
            if (!testFlightConfig()) return yield* failNoStore(404, "Not found");
            const status = yield* appleFailure(forgetInvite(identity));
            return json(status, { headers: noStore });
          }),
        ),
    },
  },
});
