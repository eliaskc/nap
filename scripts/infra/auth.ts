import { Credentials, CloudflareApiLive, CloudflareEnvironment } from "alchemy/Cloudflare";
import { AuthProviders } from "alchemy/Auth";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

// Use the nap Alchemy profile.
export const cloudflareAuth = () => {
  process.env.ALCHEMY_PROFILE ??= "nap";
  return Effect.runPromise(
    Effect.gen(function* () {
      const credentials = yield* yield* Credentials;
      const { accountId } = yield* yield* CloudflareEnvironment;
      const headers: Record<string, string> =
        credentials.type === "apiKey"
          ? { "X-Auth-Key": Redacted.value(credentials.apiKey), "X-Auth-Email": credentials.email }
          : {
              Authorization: `Bearer ${Redacted.value(credentials.type === "oauth" ? credentials.accessToken : credentials.apiToken)}`,
            };
      return { accountId, headers };
    }).pipe(
      Effect.provide(CloudflareApiLive()),
      Effect.provideService(AuthProviders, {}),
      Effect.provide(PlatformServices),
    ),
  );
};
