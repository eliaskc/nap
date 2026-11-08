import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { signedIn } from "~/lib/nap-server";
import {
  hasTarget,
  notificationsOn,
  removeTarget,
  saveWebTarget,
  sendTest,
  webPushConfig,
} from "~/lib/notifications";
import { isLocalHostname } from "~/lib/nap-urls";
import { napConfig } from "~/nap.config";
import { failNoStore, json, noStore, readJsonObject, requireSameSite } from "~/server/http";
import { route } from "~/server/route";

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Push services are https URLs; anything else is not a browser subscription. */
const isEndpoint = (value: string) => /^https:\/\/[^\s]{8,800}$/.test(value);

/**
 * The dashboard's bell: notifications in this browser (web push).
 * GET /api/push?endpoint=… — whether they are on, the VAPID key, and whether this endpoint is on.
 * POST /api/push { endpoint, keys: { p256dh, auth }, test? } — turns them on for this browser;
 * with test, sends the person a test notification.
 * DELETE /api/push { endpoint } — turns them off.
 */
export const Route = createFileRoute("/api/push")({
  server: {
    handlers: {
      GET: ({ request }) =>
        route(
          Effect.gen(function* () {
            const identity = yield* signedIn(request);
            const config = yield* webPushConfig();
            const endpoint = text(new URL(request.url).searchParams.get("endpoint"));
            const on =
              config.enabled && endpoint ? yield* hasTarget(identity.email, endpoint) : false;
            return json({ ...config, on }, { headers: noStore });
          }),
        ),
      POST: ({ request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            const identity = yield* signedIn(request);
            if (!notificationsOn()) return yield* failNoStore(404, "Notifications are off");
            const body = yield* readJsonObject(request);
            const keys = (body.keys ?? {}) as Record<string, unknown>;
            const endpoint = text(body.endpoint);
            const p256dh = text(keys.p256dh);
            const auth = text(keys.auth);
            if (!isEndpoint(endpoint) || !p256dh || !auth) {
              return yield* failNoStore(400, "Send the browser's push subscription");
            }
            const label = (request.headers.get("user-agent") ?? "").slice(0, 120);
            yield* saveWebTarget(identity.email, { endpoint, p256dh, auth }, label);
            // Turning them on sends one to this person, so they see it works.
            if (body.test === true) {
              const url = new URL(request.url);
              const local = isLocalHostname(url.hostname) ? url.origin : null;
              yield* sendTest(identity, { rootDomain: napConfig.rootDomain, localOrigin: local });
            }
            return json({ ok: true }, { headers: noStore });
          }),
        ),
      DELETE: ({ request }) =>
        route(
          Effect.gen(function* () {
            yield* requireSameSite(request);
            const identity = yield* signedIn(request);
            const endpoint = text((yield* readJsonObject(request)).endpoint);
            if (endpoint) yield* removeTarget(identity.email, endpoint);
            return json({ ok: true }, { headers: noStore });
          }),
        ),
    },
  },
});
