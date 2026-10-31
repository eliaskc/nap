import { AwsV4Signer } from "aws4fetch";

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
export type R2Credentials = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export async function presignPut(
  credentials: R2Credentials,
  key: string,
  options: { contentType: string; contentLength: number; expiresInSeconds: number },
) {
  const path = key
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
  const url = new URL(
    `https://${credentials.accountId}.r2.cloudflarestorage.com/${credentials.bucket}/${path}`,
  );
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
  const signed = await signer.sign();
  return { url: signed.url.toString(), headers: { "content-type": options.contentType } };
}
