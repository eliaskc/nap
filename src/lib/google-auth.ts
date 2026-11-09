import { Effect, Schema } from "effect";
import { importPKCS8, SignJWT } from "jose";
import { Settings } from "~/server/platform";

/**
 * Google APIs as Nap's service account (NAP_PLAY_SERVICE_ACCOUNT): OAuth tokens from a signed JWT,
 * one per scope, kept in memory until shortly before they expire. Google Play uploads use it, and
 * so do notifications to Android phones (Firebase Cloud Messaging).
 */

export class GoogleAuthError extends Schema.TaggedError<GoogleAuthError>()("GoogleAuthError", {
  message: Schema.String,
}) {}

const cache = new Map<string, { token: string; expires: number }>();

/** An access token for `scope`, for the service account. */
export const googleToken = Effect.fn("googleToken")(function* (scope: string) {
  const { play } = yield* Settings;
  if (!play)
    return yield* new GoogleAuthError({ message: "The Google service account is not set up" });
  const key = `${play.clientEmail} ${scope}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const assertion = yield* Effect.promise(async () => {
    const pem = await importPKCS8(play.privateKey.replace(/\\n/g, "\n"), "RS256");
    return new SignJWT({ scope })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(play.clientEmail)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(pem);
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
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !data.access_token) {
    return yield* new GoogleAuthError({
      message: `Google would not sign in the service account: ${data.error_description ?? response.status}`,
    });
  }
  cache.set(key, {
    token: data.access_token,
    expires: Date.now() + (data.expires_in ?? 3600) * 1000,
  });
  return data.access_token;
});
