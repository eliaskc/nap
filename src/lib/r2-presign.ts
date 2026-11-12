import { AwsV4Signer } from "aws4fetch";
import { Effect } from "effect";
import type { R2Credentials } from "~/server/platform";

/**
 * Presigned R2 uploads. A presigned URL lets a client PUT one object straight to R2's S3 API
 * (<account>.r2.cloudflarestorage.com), so large uploads never pass through the Worker. The
 * signature covers the key, the method, the expiry, the content type, and the content length:
 * R2 refuses a request that changes any of them.
 *
 * The R2 credentials come from an account API token with "Workers R2 Storage Bucket Item Write"
 * on the Nap bucket only. Its access key id is the token id; the secret access key is the SHA-256
 * of the token value.
 */
/** The object's URL on R2's S3 API, with each key segment encoded as S3 signs it. */
function objectUrl(credentials: R2Credentials, key: string) {
  const path = key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
  return `https://${credentials.accountId}.r2.cloudflarestorage.com/${credentials.bucket}/${path}`;
}

export const presignPut = Effect.fnUntraced(function* (
  credentials: R2Credentials,
  key: string,
  options: { contentType: string; contentLength: number; expiresInSeconds: number },
) {
  const url = new URL(objectUrl(credentials, key));
  url.searchParams.set("X-Amz-Expires", String(options.expiresInSeconds));
  const headers = {
    "content-type": options.contentType,
    "content-length": String(options.contentLength),
  };
  const signer = new AwsV4Signer({
    method: "PUT",
    url: url.toString(),
    headers,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    service: "s3",
    region: "auto",
    signQuery: true,
    // Sign content-type and content-length too, so the client cannot change the type or size.
    allHeaders: true,
  });
  const signed = yield* Effect.promise(() => signer.sign());
  return {
    url: signed.url.toString(),
    headers: { "content-type": options.contentType } as Record<string, string>,
  };
});

/**
 * A presigned GET of one object, for someone who cannot sign in, such as a phone showing a
 * notification's image. Anyone with the URL can read the object until it expires (at most 7 days).
 */
export const presignGet = Effect.fnUntraced(function* (
  credentials: R2Credentials,
  key: string,
  expiresInSeconds: number,
) {
  const url = new URL(objectUrl(credentials, key));
  url.searchParams.set("X-Amz-Expires", String(Math.min(expiresInSeconds, 604_800)));
  const signer = new AwsV4Signer({
    method: "GET",
    url: url.toString(),
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    service: "s3",
    region: "auto",
    signQuery: true,
  });
  const signed = yield* Effect.promise(() => signer.sign());
  return signed.url.toString();
});
