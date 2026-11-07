import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { appSheet, appsEnabled, dismissAppNudge } from "~/lib/apps";
import { signedIn } from "~/lib/nap-server";
import { json, noStore, readJsonObject, requireSameSite } from "~/server/http";
import { route } from "~/server/route";

/**
 * The dashboard's Get the app sheet. Everyone who can sign in.
 * GET /api/app — the app, each platform's live build with what's inside, and whether the caller
 * dismissed the nudge. { enabled: false } when apps are off.
 * POST /api/app { dismissNudge: true } — hides the nudge for the caller.
 */
export const Route = createFileRoute("/api/app")({
  server: {
    handlers: {
      GET: ({ request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            if (!appsEnabled()) return json({ enabled: false }, { headers: noStore });
            const sheet = yield* appSheet(identity.email, new URL(request.url).origin);
            return json({ enabled: true, ...sheet }, { headers: noStore });
          }),
        ),
      POST: ({ request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            const identity = yield* signedIn(request);
            const body = yield* readJsonObject(request);
            if (body.dismissNudge === true) yield* dismissAppNudge(identity.email);
            return json({ ok: true }, { headers: noStore });
          }),
        ),
    },
  },
});
