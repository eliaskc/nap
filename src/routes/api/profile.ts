import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { signedIn } from "~/lib/nap-server";
import { saveProfile, welcomeState } from "~/lib/profiles";
import { json, noStore, readJsonObject, requireJsonBody, requireSameSite } from "~/server/http";
import { route } from "~/server/route";

/**
 * GET /api/profile — the caller's name and look, a guess at their name, and the looks other
 * people have (for the picker on /welcome).
 * POST /api/profile — `{ name, shape, color }`. 409 when someone else has that look.
 */
export const Route = createFileRoute("/api/profile")({
  server: {
    handlers: {
      GET: ({ request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const providerName = request.headers.get("cf-access-authenticated-user-name");
            return json(yield* welcomeState(identity, providerName), { headers: noStore });
          }),
        ),
      POST: ({ request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            yield* requireJsonBody(request);
            const identity = yield* signedIn(request);
            const body = yield* readJsonObject(request);
            const me = yield* saveProfile(identity, {
              name: body.name,
              shape: body.shape,
              color: body.color,
            });
            return json({ me }, { headers: noStore });
          }),
        ),
    },
  },
});
