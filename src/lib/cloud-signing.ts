import { Effect, Schema } from "effect";
import { napConfig } from "~/nap.config";
import { Settings } from "~/server/platform";

/**
 * Cloud signing for iOS (napConfig.apps.ios.signing.cloud): builds are signed with Apple's
 * cloud-managed distribution certificate instead of a certificate the deployment holds. Apple
 * keeps that certificate's key, and only Xcode can sign with it, so Nap cannot: a macOS job in
 * the deployment's config repository does (infra/config-repo-sign-ios.yml, which runs
 * scripts/apps/cloud-sign.py).
 *
 * 1. An agent publishes a build as always. Nap stores it, turns on the capabilities it asks for,
 *    and starts the workflow with the build's id. The build stays `signing`.
 * 2. The job asks Nap what to sign (GET /_nap/api/signing/builds/<id>), downloads the unsigned
 *    build, signs it with `xcodebuild -exportArchive`, and sends the .ipa back.
 * 3. Nap uploads the .ipa to TestFlight and makes the build live, as it does after signing itself.
 *
 * The job has no Nap token. It shows the deployment's signing secret, which both sides get from
 * the config repository's secrets. The routes are in apps.ts (handleSigningApi).
 */

export class SigningJobError extends Schema.TaggedError<SigningJobError>()("SigningJobError", {
  message: Schema.String,
}) {}

/** The cloud signing settings, or null when Nap signs itself. */
export const cloudSigning = () => napConfig.apps?.ios?.signing?.cloud ?? null;

/** What Nap keeps for the job between the publish and the job's questions. */
export type SigningJob = {
  /** Entitlements beyond the basic ones that the build should get, from its capabilities. */
  entitlementKeys: Array<string>;
  /** What each app asked for and does not get, for the launcher to show. */
  warnings: Record<string, Array<string>>;
  capabilities: Array<string>;
};

/** Starts the signing workflow for a build. GitHub answers before the job runs. */
export const startSigningJob = Effect.fn("startSigningJob")(function* (build: string) {
  const cloud = cloudSigning();
  const { cloudSigning: secrets, rootDomain } = yield* Settings;
  if (!cloud || !secrets) {
    return yield* new SigningJobError({ message: "Cloud signing is not set up" });
  }
  const workflow = cloud.workflow ?? "sign-ios.yml";
  const response = yield* Effect.promise(() =>
    fetch(
      `https://api.github.com/repos/${cloud.repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secrets.githubToken}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "nap",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({
          ref: cloud.ref ?? "main",
          inputs: { build, nap: `https://${rootDomain}` },
        }),
      },
    ).catch(() => null),
  );
  if (response?.ok) return;
  const detail = response
    ? ((yield* Effect.promise(() => response.json().catch(() => ({})))) as { message?: string })
        .message
    : "GitHub could not be reached";
  yield* Effect.logWarning("Starting the signing job failed").pipe(
    Effect.annotateLogs({ build, status: response?.status ?? 0, detail }),
  );
  return yield* new SigningJobError({
    message: `Could not start the signing job (${workflow} in ${cloud.repository}): ${detail ?? response?.status}. Ask ${napConfig.admin}.`,
  });
});

/** Whether the request carries the deployment's signing secret. */
export const isSigningJob = Effect.fnUntraced(function* (request: Request) {
  const { cloudSigning: secrets } = yield* Settings;
  const sent = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!cloudSigning() || !secrets || !sent) return false;
  // Compare digests, so the time taken says nothing about the secret.
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((b) => new Uint8Array(b));
  const [a, b] = yield* Effect.promise(() => Promise.all([digest(sent), digest(secrets.secret)]));
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i]! ^ b[i]!;
  return different === 0;
});
