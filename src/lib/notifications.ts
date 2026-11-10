import { Effect } from "effect";
import type { Identity } from "~/lib/nap-server";
import { napUrl, type NapKind, type NapPlace } from "~/lib/nap-urls";
import {
  apnsToken,
  encryptWebPush,
  newVapidKeys,
  vapidAuthorization,
  vapidPublicKey,
  type VapidKeys,
} from "~/lib/push-crypto";
import { googleToken } from "~/lib/google-auth";
import { viewersAmong } from "~/lib/site-data";
import { napConfig } from "~/nap.config";
import { Database } from "~/server/database";
import { failNoStore, isCrossSite, json, noStore, readJsonObject } from "~/server/http";
import { inBackground, Settings } from "~/server/platform";

/**
 * Notifications (napConfig.notifications). A page sends one with nap.notify({ title, body, open })
 * and an app with NapKit's Nap.notify; Nap sends it to everyone else who can see the page, on
 * every phone with the app (APNs on iPhones, Firebase Cloud Messaging on Android) and every browser that turned them on (web push). The sender
 * never gets their own. Each send is logged in `notifications`, which the rate limits count.
 */

export const notificationsOn = () => napConfig.notifications === true;

/** What a notification came from: a site or artifact, or the app itself (NapKit, no site). */
export type NotificationSource =
  | { kind: "site"; slug: string; title: string; napKind: NapKind; place: NapPlace }
  | { kind: "app"; app: string | null; place: NapPlace };

/** Which app in the launcher a notification from the app itself belongs to, so a tap opens it. */
export const readAppSlug = (value: unknown) =>
  typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value) ? value : null;

/** Per sender and per source. Generous for "wants to play", tight enough to stop a loop. */
const LIMITS = {
  senderPerMinute: 3,
  senderPerDay: 50,
  sourcePerMinute: 6,
};
const TITLE_MAX = 80;
const SKIP_MAX = 100;

/** `skip`: emails to leave out, compared without case. Anything else in the list is ignored. */
const readSkip = (value: unknown) =>
  new Set(
    (Array.isArray(value) ? value : [])
      .filter((email): email is string => typeof email === "string")
      .slice(0, SKIP_MAX)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
const BODY_MAX = 240;

const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type Target = {
  id: string;
  email: string;
  kind: "apns" | "fcm" | "web";
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
  environment: string | null;
};

// ---- Keys ----------------------------------------------------------------------------------

/** The VAPID key pair, made the first time it is needed and kept in nap_keys. */
const vapidKeys = Effect.fn("vapidKeys")(function* () {
  const db = yield* Database;
  const stored = yield* db.first<{ value: string }>(
    "SELECT value FROM nap_keys WHERE name = 'vapid'",
  );
  if (stored) return JSON.parse(stored.value) as VapidKeys;
  const made = yield* Effect.promise(() => newVapidKeys());
  // Two first requests at once: the first insert wins, and both read it back.
  yield* db.run(
    "INSERT INTO nap_keys (name, value) VALUES ('vapid', ?) ON CONFLICT DO NOTHING",
    JSON.stringify(made),
  );
  const kept = yield* db.first<{ value: string }>(
    "SELECT value FROM nap_keys WHERE name = 'vapid'",
  );
  return JSON.parse(kept!.value) as VapidKeys;
});

/** For the dashboard's bell: whether notifications are on, and the key browsers subscribe with. */
export const webPushConfig = Effect.fn("webPushConfig")(function* () {
  if (!notificationsOn()) return { enabled: false as const };
  return { enabled: true as const, vapidPublicKey: vapidPublicKey(yield* vapidKeys()) };
});

/** iOS: on when the instance has notifications, iOS, and an APNs key. */
export const apnsConfig = Effect.fn("apnsConfig")(function* () {
  const { apns } = yield* Settings;
  const ios = napConfig.apps?.ios;
  if (!notificationsOn() || !apns || !ios) return null;
  return { ...apns, teamId: ios.teamId, topic: ios.bundleId };
});

/**
 * Android: on when the instance has notifications and Firebase for the Android app, and a Google
 * service account to send as. The Firebase values are what the launcher initializes with.
 */
export const fcmConfig = Effect.fn("fcmConfig")(function* () {
  const { play } = yield* Settings;
  const firebase = napConfig.apps?.android?.firebase;
  if (!notificationsOn() || !play || !firebase) return null;
  return firebase;
});

// ---- Where they go -------------------------------------------------------------------------

/** A browser turned them on: its push subscription, for this person. */
export const saveWebTarget = Effect.fn("saveWebTarget")(function* (
  email: string,
  subscription: { endpoint: string; p256dh: string; auth: string },
  label: string,
) {
  const db = yield* Database;
  // The same endpoint again (a new sign-in on the browser) moves to whoever turned it on now.
  yield* db.run(
    `INSERT INTO push_targets (id, email, kind, endpoint, p256dh, auth, label)
     VALUES (?, ?, 'web', ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET email = excluded.email, p256dh = excluded.p256dh,
       auth = excluded.auth, label = excluded.label, last_seen_at = ?`,
    crypto.randomUUID(),
    email,
    subscription.endpoint,
    subscription.p256dh,
    subscription.auth,
    label.slice(0, 120),
    now(),
  );
});

/** A phone with the app: its APNs device token, for this person. */
export const saveApnsTarget = Effect.fn("saveApnsTarget")(function* (
  email: string,
  device: { token: string; environment: "production" | "sandbox" },
  label: string,
) {
  const db = yield* Database;
  yield* db.run(
    `INSERT INTO push_targets (id, email, kind, endpoint, environment, label)
     VALUES (?, ?, 'apns', ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET email = excluded.email,
       environment = excluded.environment, label = excluded.label, last_seen_at = ?`,
    crypto.randomUUID(),
    email,
    device.token,
    device.environment,
    label.slice(0, 120),
    now(),
  );
});

/** An Android phone with the app: its Firebase Cloud Messaging token, for this person. */
export const saveFcmTarget = Effect.fn("saveFcmTarget")(function* (
  email: string,
  token: string,
  label: string,
) {
  const db = yield* Database;
  yield* db.run(
    `INSERT INTO push_targets (id, email, kind, endpoint, label)
     VALUES (?, ?, 'fcm', ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET email = excluded.email, label = excluded.label,
       last_seen_at = ?`,
    crypto.randomUUID(),
    email,
    token,
    label.slice(0, 120),
    now(),
  );
});

/** Turns one off: only the person's own. */
export const removeTarget = Effect.fn("removeTarget")(function* (email: string, endpoint: string) {
  const db = yield* Database;
  yield* db.run(
    "DELETE FROM push_targets WHERE endpoint = ? AND lower(email) = lower(?)",
    endpoint,
    email,
  );
});

/** Whether this browser's endpoint is on, for this person. */
export const hasTarget = Effect.fn("hasTarget")(function* (email: string, endpoint: string) {
  const db = yield* Database;
  const row = yield* db.first(
    "SELECT 1 FROM push_targets WHERE endpoint = ? AND lower(email) = lower(?)",
    endpoint,
    email,
  );
  return Boolean(row);
});

// ---- Sending -------------------------------------------------------------------------------

type Message = { title: string; subtitle: string; body: string; url: string; source: string };

const dropTarget = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db.run("DELETE FROM push_targets WHERE id = ?", id);
  });

const sendWeb = Effect.fnUntraced(function* (target: Target, message: Message, keys: VapidKeys) {
  const { rootDomain } = yield* Settings;
  const response = yield* Effect.promise(async () => {
    const body = await encryptWebPush(
      new TextEncoder().encode(JSON.stringify(message)),
      target.p256dh ?? "",
      target.auth ?? "",
    );
    return fetch(target.endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidAuthorization(keys, target.endpoint, `https://${rootDomain}`),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: "86400",
        urgency: "high",
      },
      body,
    });
  });
  // The browser unsubscribed or the subscription expired.
  if (response.status === 404 || response.status === 410) return yield* dropTarget(target.id);
  if (!response.ok) {
    yield* Effect.logWarning("Web push failed").pipe(
      Effect.annotateLogs({
        status: response.status,
        host: new URL(target.endpoint).host,
        error: (yield* Effect.promise(() => response.text())).slice(0, 300),
      }),
    );
  }
});

const sendApns = Effect.fnUntraced(function* (
  target: Target,
  message: Message,
  apns: { keyId: string; privateKey: string; teamId: string; topic: string },
) {
  const host =
    target.environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const response = yield* Effect.promise(async () =>
    fetch(`https://${host}/3/device/${target.endpoint}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${await apnsToken(apns.keyId, apns.teamId, apns.privateKey)}`,
        "apns-topic": apns.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
      },
      body: JSON.stringify({
        aps: {
          alert: {
            title: message.title,
            ...(message.subtitle ? { subtitle: message.subtitle } : {}),
            ...(message.body ? { body: message.body } : {}),
          },
          sound: "default",
          "thread-id": message.source,
        },
        url: message.url,
        source: message.source,
      }),
    }),
  );
  if (response.ok) return;
  const reason = yield* Effect.promise(() =>
    response
      .json()
      .then((body) => String((body as { reason?: unknown }).reason ?? ""))
      .catch(() => ""),
  );
  // The app was deleted, or the token is not one of this app's.
  if (response.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") {
    return yield* dropTarget(target.id);
  }
  yield* Effect.logWarning("APNs failed").pipe(
    Effect.annotateLogs({ status: response.status, reason, environment: target.environment }),
  );
});

const sendFcm = Effect.fnUntraced(function* (
  target: Target,
  message: Message,
  firebase: { projectId: string },
) {
  const token = yield* googleToken("https://www.googleapis.com/auth/firebase.messaging");
  const response = yield* Effect.promise(() =>
    fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(firebase.projectId)}/messages:send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token: target.endpoint,
            notification: {
              title: message.subtitle ? `${message.title} · ${message.subtitle}` : message.title,
              ...(message.body ? { body: message.body } : {}),
            },
            // The launcher opens what a tap asks for from these, and shows the notification
            // itself while it is open.
            data: {
              url: message.url,
              source: message.source,
              title: message.title,
              subtitle: message.subtitle,
              body: message.body,
            },
            android: {
              priority: "high",
              notification: { channel_id: "nap", tag: message.source },
            },
          },
        }),
      },
    ),
  );
  if (response.ok) return;
  const error = yield* Effect.promise(() =>
    response
      .json()
      .then(
        (body) =>
          (
            body as {
              error?: {
                status?: string;
                message?: string;
                details?: Array<{ errorCode?: string }>;
              };
            }
          ).error ?? {},
      )
      .catch(
        () =>
          ({}) as { status?: string; message?: string; details?: Array<{ errorCode?: string }> },
      ),
  );
  const code = error.details?.find((detail) => detail.errorCode)?.errorCode ?? error.status ?? "";
  // The app was uninstalled, or the token is not one of this project's.
  if (response.status === 404 || code === "UNREGISTERED" || code === "SENDER_ID_MISMATCH") {
    return yield* dropTarget(target.id);
  }
  yield* Effect.logWarning("FCM failed").pipe(
    Effect.annotateLogs({
      status: response.status,
      code,
      error: (error.message ?? "").slice(0, 300),
    }),
  );
});

type Senders = {
  apns: Effect.Success<ReturnType<typeof apnsConfig>>;
  fcm: Effect.Success<ReturnType<typeof fcmConfig>>;
  keys: VapidKeys | null;
};

/** The targets this Nap can reach now: phones only with their platform's keys set up. */
const reachable = (targets: Array<Target>, senders: Omit<Senders, "keys">) =>
  targets.filter(
    (target) =>
      target.kind === "web" ||
      (target.kind === "apns" && senders.apns) ||
      (target.kind === "fcm" && senders.fcm),
  );

const sendTo = (target: Target, message: Message, senders: Senders) =>
  (target.kind === "web"
    ? sendWeb(target, message, senders.keys!)
    : target.kind === "apns"
      ? sendApns(target, message, senders.apns!)
      : sendFcm(target, message, senders.fcm!)
  ).pipe(Effect.catchCause((cause) => Effect.logWarning("Push failed", cause)));

/** Where a tap goes: a page on this Nap, by default the source's own. */
function resolveOpen(source: NotificationSource, open: string) {
  const { rootDomain } = source.place;
  const localOrigin = source.place.localOrigin ?? null;
  const home =
    source.kind === "site"
      ? napUrl({ slug: source.slug, kind: source.napKind }, source.place)
      : (localOrigin ?? `https://${rootDomain}`) + "/";
  if (!open) return home;
  let url: URL;
  try {
    url = new URL(open, home);
  } catch {
    return null;
  }
  const host = url.hostname;
  const ours =
    host === rootDomain ||
    host.endsWith(`.${rootDomain}`) ||
    (localOrigin !== null && url.origin === new URL(localOrigin).origin);
  return ours && (url.protocol === "https:" || localOrigin !== null) ? url.href : null;
}

const sourceKey = (source: NotificationSource) =>
  source.kind === "site" ? `site:${source.slug}` : source.app ? `app:${source.app}` : "app";

/**
 * Sends one notification. Fails with the reason the sender should see: off, too many, or a bad
 * title or link. Delivery happens after the response; the answer counts the people it goes to.
 */
export const sendNotification = Effect.fn("sendNotification")(function* (
  source: NotificationSource,
  sender: Identity,
  input: { title?: unknown; body?: unknown; open?: unknown; skip?: unknown },
) {
  if (!notificationsOn()) {
    return yield* failNoStore(404, "Notifications are off on this Nap", {
      code: "notifications_off",
    });
  }
  const title = typeof input.title === "string" ? input.title.trim().slice(0, TITLE_MAX) : "";
  const body = typeof input.body === "string" ? input.body.trim().slice(0, BODY_MAX) : "";
  if (!title) return yield* failNoStore(400, "Give the notification a title");
  const url = resolveOpen(source, typeof input.open === "string" ? input.open.trim() : "");
  if (!url) {
    return yield* failNoStore(400, `open must be a page on ${source.place.rootDomain}`);
  }

  const db = yield* Database;
  const key = sourceKey(source);
  const counts = yield* db.first<{ minute: number; day: number; source: number }>(
    `SELECT
       (SELECT count(*) FROM notifications WHERE lower(sender_email) = lower(?1) AND created_at > ?2) AS minute,
       (SELECT count(*) FROM notifications WHERE lower(sender_email) = lower(?1) AND created_at > ?3) AS day,
       (SELECT count(*) FROM notifications WHERE source = ?4 AND created_at > ?2) AS source`,
    sender.email,
    ago(60_000),
    ago(86_400_000),
    key,
  );
  if (
    (counts?.minute ?? 0) >= LIMITS.senderPerMinute ||
    (counts?.source ?? 0) >= LIMITS.sourcePerMinute
  ) {
    return yield* failNoStore(429, "Too many notifications. Wait a minute and try again.", {
      code: "rate_limited",
    });
  }
  if ((counts?.day ?? 0) >= LIMITS.senderPerDay) {
    return yield* failNoStore(429, "That's all the notifications you can send today.", {
      code: "rate_limited",
    });
  }

  // Everyone else's phones and browsers. From a page, only people who can see that page.
  const apns = yield* apnsConfig();
  const fcm = yield* fcmConfig();
  let targets = reachable(
    yield* db.all<Target>(
      `SELECT id, email, kind, endpoint, p256dh, auth, environment FROM push_targets
       WHERE lower(email) <> lower(?)`,
      sender.email,
    ),
    { apns, fcm },
  );
  // People the sender leaves out, such as those who were there for what it is about.
  const skip = readSkip(input.skip);
  if (skip.size) targets = targets.filter((target) => !skip.has(target.email.toLowerCase()));
  if (source.kind === "site") {
    const viewers = yield* viewersAmong(source.slug, [...new Set(targets.map((t) => t.email))]);
    targets = targets.filter((target) => viewers.has(target.email.toLowerCase()));
  }
  const people = new Set(targets.map((target) => target.email.toLowerCase())).size;

  yield* db.run(
    `INSERT INTO notifications (id, source, sender_email, title, body, url, recipients)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    key,
    sender.email,
    title,
    body,
    url,
    people,
  );
  yield* Effect.logInfo("Notification").pipe(
    Effect.annotateLogs({ source: key, sender: sender.email, people, targets: targets.length }),
  );

  const message: Message = {
    title,
    subtitle: source.kind === "site" && source.title !== title ? source.title : "",
    body,
    url,
    source: key,
  };
  if (targets.length) {
    const keys = targets.some((target) => target.kind === "web") ? yield* vapidKeys() : null;
    yield* inBackground(
      Effect.forEach(targets, (target) => sendTo(target, message, { apns, fcm, keys }), {
        concurrency: 8,
        discard: true,
      }),
      "Sending a notification failed",
    );
  }
  return { sent: people };
});

/**
 * A test to the person's own phones and browsers ("Notifications work"), so they can check them.
 * Counts toward their limits like any other.
 */
export const sendTest = Effect.fn("sendTest")(function* (person: Identity, place: NapPlace) {
  if (!notificationsOn()) {
    return yield* failNoStore(404, "Notifications are off on this Nap", {
      code: "notifications_off",
    });
  }
  const db = yield* Database;
  const counts = yield* db.first<{ minute: number }>(
    `SELECT count(*) AS minute FROM notifications
     WHERE lower(sender_email) = lower(?) AND created_at > ?`,
    person.email,
    ago(60_000),
  );
  if ((counts?.minute ?? 0) >= LIMITS.senderPerMinute) {
    return yield* failNoStore(429, "Too many notifications. Wait a minute and try again.", {
      code: "rate_limited",
    });
  }
  const apns = yield* apnsConfig();
  const fcm = yield* fcmConfig();
  const targets = reachable(
    yield* db.all<Target>(
      `SELECT id, email, kind, endpoint, p256dh, auth, environment FROM push_targets
       WHERE lower(email) = lower(?)`,
      person.email,
    ),
    { apns, fcm },
  );
  const url = (place.localOrigin ?? `https://${place.rootDomain}`) + "/";
  yield* db.run(
    `INSERT INTO notifications (id, source, sender_email, title, url, recipients)
     VALUES (?, 'test', ?, 'Notifications work', ?, 1)`,
    crypto.randomUUID(),
    person.email,
    url,
  );
  const message: Message = {
    title: "Notifications work",
    subtitle: "",
    body: `This is how ${napConfig.orgName} reaches you.`,
    url,
    source: "test",
  };
  const keys = targets.some((target) => target.kind === "web") ? yield* vapidKeys() : null;
  // Waits for delivery, so the answer can say what happened.
  yield* Effect.forEach(targets, (target) => sendTo(target, message, { apns, fcm, keys }), {
    concurrency: 8,
    discard: true,
  });
  return { devices: targets.length };
});

/**
 * POST /_nap/notify on a site (and in artifact frames, and /_nap/api/naps/<slug>/notify with a
 * token): { title, body?, open? }. The viewer sends it, from the page.
 */
export const handleNotifyRequest = Effect.fn("handleNotifyRequest")(function* (
  slug: string,
  request: Request,
  identity: Identity,
  place: NapPlace,
  options: { frame?: boolean; token?: boolean } = {},
) {
  // Whether this Nap sends notifications, so a page can leave out a button that would fail.
  if (request.method === "GET") return json({ enabled: notificationsOn() }, { headers: noStore });
  if (request.method !== "POST") return yield* failNoStore(405, "Use GET or POST");
  if (!options.frame && !options.token && isCrossSite(request)) {
    return yield* failNoStore(403, "Forbidden");
  }
  const db = yield* Database;
  const site = yield* db.first<{ slug: string; title: string; kind: NapKind }>(
    "SELECT slug, title, kind FROM sites WHERE slug = ?",
    slug,
  );
  if (!site) return yield* failNoStore(404, "Not found");
  const viewers = yield* viewersAmong(slug, [identity.email]);
  if (!viewers.has(identity.email.toLowerCase())) return yield* failNoStore(403, "Forbidden");
  const body = yield* readJsonObject(request);
  const result = yield* sendNotification(
    { kind: "site", slug, title: site.title, napKind: site.kind, place },
    identity,
    body,
  );
  return json(result, { headers: noStore });
});
