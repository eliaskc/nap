import { Effect, Schema } from "effect";
import { importPKCS8, SignJWT } from "jose";
import { napConfig } from "~/nap.config";
import { Settings } from "~/server/platform";
import { Storage } from "~/server/storage";

/**
 * Google's side of Android apps: the Google Play Developer API, with a service account that has
 * access to the app in Play Console.
 *
 * Nap uploads each signed bundle in an edit (Play's unit of change), puts it on the internal
 * testing track as the only release there, and commits the edit. A new app is a draft in Play
 * Console until its first release is rolled out by hand, and Play then only takes draft releases:
 * Nap makes one, and someone rolls it out. Before any bundle exists, Play may not know the app
 * to the API at all; then someone uploads the first bundle by hand.
 */

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TRACK = "internal";

export class PlayError extends Schema.TaggedError<PlayError>()("PlayError", {
  message: Schema.String,
  /** Play does not take this release through the API: the app is still a draft. */
  draftOnly: Schema.Boolean,
  /** Play does not know the app to the API (no bundle yet, or no access for the account). */
  notFound: Schema.Boolean,
}) {}

const playError = (message: string, flags: { draftOnly?: boolean; notFound?: boolean } = {}) =>
  new PlayError({
    message,
    draftOnly: flags.draftOnly ?? false,
    notFound: flags.notFound ?? false,
  });

const packageName = Effect.suspend(() => {
  const name = napConfig.apps?.android?.packageName;
  return name ? Effect.succeed(name) : Effect.fail(playError("Android is off on this Nap"));
});

/** Whether Nap can upload to Play: a service account is set up. */
export const playConfigured = Effect.gen(function* () {
  const { play } = yield* Settings;
  return play !== null;
});

/** An hour-long OAuth token for the service account, from a signed JWT. */
const accessToken = Effect.fnUntraced(function* () {
  const { play } = yield* Settings;
  if (!play) return yield* playError("The Google Play service account is not set up");
  const assertion = yield* Effect.promise(async () => {
    const key = await importPKCS8(play.privateKey.replace(/\\n/g, "\n"), "RS256");
    return new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(play.clientEmail)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(key);
  });
  const response = yield* Effect.promise(() =>
    fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    }),
  );
  const data = (yield* Effect.promise(() => response.json().catch(() => ({})))) as {
    access_token?: string;
    error_description?: string;
  };
  if (!response.ok || !data.access_token) {
    return yield* playError(
      `Google would not sign in the Play service account: ${data.error_description ?? response.status}`,
    );
  }
  return data.access_token;
});

/** A call to the Play Developer API. Errors carry Google's message. */
const play = Effect.fnUntraced(function* <T>(
  token: string,
  url: string,
  init: { method?: string; body?: unknown; raw?: BodyInit; contentType?: string } = {},
) {
  const response = yield* Effect.promise(() =>
    fetch(url, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": init.contentType ?? "application/json",
      },
      body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    }),
  );
  if (response.status === 204) return {} as T;
  const data = (yield* Effect.promise(() => response.json().catch(() => ({})))) as {
    error?: { message?: string; status?: string };
  };
  if (!response.ok) {
    const message = data.error?.message ?? response.statusText;
    yield* Effect.logWarning("Google Play request failed").pipe(
      Effect.annotateLogs({
        method: init.method ?? "GET",
        path: new URL(url).pathname,
        status: response.status,
        message,
      }),
    );
    return yield* playError(`Google Play: ${message}`, {
      draftOnly: /draft app|status draft/i.test(message),
      notFound: response.status === 404 || /package not found/i.test(message),
    });
  }
  return data as T;
});

const openEdit = Effect.fnUntraced(function* (token: string, pkg: string) {
  const edit = yield* play<{ id: string }>(token, `${API}/${pkg}/edits`, {
    method: "POST",
    body: {},
  });
  return edit.id;
});

const deleteEdit = (token: string, pkg: string, edit: string) =>
  play(token, `${API}/${pkg}/edits/${edit}`, { method: "DELETE" }).pipe(Effect.ignore);

/**
 * The highest version code Play has for the app, from any source: the next build must be higher.
 * 0 when Play has none, or does not know the app to the API yet.
 */
export const latestPlayVersionCode = Effect.fn("latestPlayVersionCode")(function* () {
  const pkg = yield* packageName;
  const token = yield* accessToken();
  const edit = yield* openEdit(token, pkg).pipe(
    Effect.catchIf(
      (error) => error.notFound,
      () => Effect.succeed(null),
    ),
  );
  if (!edit) return 0;
  const bundles = yield* play<{ bundles?: Array<{ versionCode?: number }> }>(
    token,
    `${API}/${pkg}/edits/${edit}/bundles`,
  ).pipe(Effect.ensuring(deleteEdit(token, pkg, edit)));
  return Math.max(0, ...(bundles.bundles ?? []).map((bundle) => Number(bundle.versionCode) || 0));
});

/** How a release reached Play: released to internal testers, or a draft to roll out by hand. */
export type PlayUpload = { state: "released" | "draft" };

/**
 * Uploads a signed bundle from R2 to Play and makes it the release on the internal testing track.
 * When Play only takes drafts (a draft app), it makes a draft release instead.
 */
export const uploadToPlay = Effect.fn("uploadToPlay")(function* (
  bundleKey: string,
  versionCode: number,
  notes: string,
) {
  const attempt = (status: "completed" | "draft") =>
    Effect.gen(function* () {
      const pkg = yield* packageName;
      const token = yield* accessToken();
      const storage = yield* Storage;
      const bundle = yield* storage.get(bundleKey);
      if (!bundle) return yield* playError("The signed bundle is missing");
      const edit = yield* openEdit(token, pkg);
      return yield* Effect.gen(function* () {
        const { readable, writable } = new FixedLengthStream(bundle.size);
        void bundle.body.pipeTo(writable).catch(() => undefined);
        const uploaded = yield* play<{ versionCode: number }>(
          token,
          `${UPLOAD}/${pkg}/edits/${edit}/bundles?uploadType=media`,
          { method: "POST", raw: readable, contentType: "application/octet-stream" },
        );
        if (uploaded.versionCode !== versionCode) {
          return yield* playError(
            `Google Play read version code ${uploaded.versionCode} from the bundle, not ${versionCode}`,
          );
        }
        const text = notes.trim().slice(0, 500);
        yield* play(token, `${API}/${pkg}/edits/${edit}/tracks/${TRACK}`, {
          method: "PUT",
          body: {
            track: TRACK,
            releases: [
              {
                versionCodes: [String(versionCode)],
                status,
                ...(text ? { releaseNotes: [{ language: "en-US", text }] } : {}),
              },
            ],
          },
        });
        yield* play(token, `${API}/${pkg}/edits/${edit}:commit`, { method: "POST" });
        return { state: status === "completed" ? "released" : "draft" } as PlayUpload;
      }).pipe(Effect.tapError(() => deleteEdit(token, pkg, edit)));
    });
  return yield* attempt("completed").pipe(
    Effect.catchIf(
      (error) => error instanceof PlayError && error.draftOnly,
      () => attempt("draft"),
    ),
  );
});
