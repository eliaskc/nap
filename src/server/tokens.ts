import { Effect } from "effect";

/** Secrets for tokens and codes. Nap stores their SHA-256, never the values. */

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** `byteLength` random bytes, base64url-encoded. */
export function randomString(byteLength: number) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** The hex SHA-256 of a string. */
export const sha256Hex = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );
