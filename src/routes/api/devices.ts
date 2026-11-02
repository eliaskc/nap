import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { adHocEnabled } from "~/lib/apps";
import { addDevice, listDevices } from "~/lib/devices";
import { signedIn } from "~/lib/nap-server";
import { fail, json, noStore, readJsonObject, requireSameSite, stringField } from "~/server/http";
import { route } from "~/server/route";

/**
 * GET /api/devices — every registered iPhone.
 * POST /api/devices { udid, name } — registers an iPhone and signs the live builds for it.
 */
export const Route = createFileRoute("/api/devices")({
  server: {
    handlers: {
      GET: ({ request }) =>
        route(
          Effect.gen(function* () {
            yield* signedIn(request);
            return json({ devices: yield* listDevices() }, { headers: noStore });
          }),
        ),
      POST: ({ request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            if (!adHocEnabled()) return yield* fail(404, "Not found");
            const identity = yield* signedIn(request);
            const body = yield* readJsonObject(request);
            return yield* addDevice(identity.email, stringField(body.udid), stringField(body.name));
          }),
        ),
    },
  },
});
