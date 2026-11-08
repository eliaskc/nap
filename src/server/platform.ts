import { Context, Effect } from "effect";

/**
 * Small services for the Worker's platform: settings from the environment, the rate limiter, and
 * background work after the response.
 */

export type R2Credentials = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type AppStoreConnectKey = { keyId: string; issuerId: string; privateKey: string };

/** The APNs key (Keys → Apple Push Notifications service), for notifications to the app. */
export type ApnsKey = { keyId: string; privateKey: string };

/**
 * A Google Cloud service account (its JSON key) with access to the Android app in Play Console,
 * for the Google Play Developer API.
 */
export type PlayServiceAccount = { clientEmail: string; privateKey: string };

/** A Cloudflare Realtime TURN key, for voice and video between the people on a nap. */
export type TurnKey = { keyId: string; token: string };

/** Settings from the Worker's environment. Empty values mean "not set up". */
export class Settings extends Context.Service<
  Settings,
  {
    readonly rootDomain: string;
    /** Direct uploads: presigned R2 URLs. Null when R2 signing is not set up. */
    readonly r2: R2Credentials | null;
    /** Apps: the App Store Connect team key. Null when it is not set up. */
    readonly appStoreConnect: AppStoreConnectKey | null;
    /** Android apps: uploads to Google Play. Null when there is no service account. */
    readonly play: PlayServiceAccount | null;
    /** Notifications to the iOS app. Null when there is no APNs key. */
    readonly apns: ApnsKey | null;
    /** Local stages only: a signer run by plain Docker instead of the container binding. */
    readonly signerUrl: string | null;
    /** /_nap/rtc: the TURN key. Null without one; pages then get STUN only. */
    readonly turn: TurnKey | null;
    /** The deployment's extension secrets by name (NAP_EXTENSION_SECRETS, a JSON object). */
    readonly extensionSecrets: Readonly<Record<string, string>>;
  }
>()("nap/Settings") {}

export type SettingsEnv = {
  NAP_ROOT_DOMAIN?: string;
  NAP_R2_ACCOUNT_ID?: string;
  NAP_R2_BUCKET?: string;
  NAP_R2_ACCESS_KEY_ID?: string;
  NAP_R2_SECRET_ACCESS_KEY?: string;
  NAP_ASC_KEY_ID?: string;
  NAP_ASC_ISSUER_ID?: string;
  NAP_ASC_PRIVATE_KEY?: string;
  NAP_APNS_KEY_ID?: string;
  NAP_APNS_PRIVATE_KEY?: string;
  NAP_PLAY_SERVICE_ACCOUNT?: string;
  NAP_SIGNER_URL?: string;
  NAP_TURN_KEY_ID?: string;
  NAP_TURN_KEY_API_TOKEN?: string;
  NAP_EXTENSION_SECRETS?: string;
};

export function settingsFromEnv(env: SettingsEnv, rootDomain: string): Settings["Service"] {
  const text = (value: unknown) => (value ? String(value) : "");
  const accountId = text(env.NAP_R2_ACCOUNT_ID);
  const bucket = text(env.NAP_R2_BUCKET);
  const accessKeyId = text(env.NAP_R2_ACCESS_KEY_ID);
  const secretAccessKey = text(env.NAP_R2_SECRET_ACCESS_KEY);
  const keyId = text(env.NAP_ASC_KEY_ID);
  const issuerId = text(env.NAP_ASC_ISSUER_ID);
  const privateKey = text(env.NAP_ASC_PRIVATE_KEY);
  const apnsKeyId = text(env.NAP_APNS_KEY_ID);
  const apnsPrivateKey = text(env.NAP_APNS_PRIVATE_KEY);
  const turnKeyId = text(env.NAP_TURN_KEY_ID);
  const turnToken = text(env.NAP_TURN_KEY_API_TOKEN);
  return Settings.of({
    rootDomain: text(env.NAP_ROOT_DOMAIN) || rootDomain,
    r2:
      accountId && bucket && accessKeyId && secretAccessKey
        ? { accountId, bucket, accessKeyId, secretAccessKey }
        : null,
    appStoreConnect: keyId && issuerId && privateKey ? { keyId, issuerId, privateKey } : null,
    play: parsePlayServiceAccount(text(env.NAP_PLAY_SERVICE_ACCOUNT)),
    apns: apnsKeyId && apnsPrivateKey ? { keyId: apnsKeyId, privateKey: apnsPrivateKey } : null,
    signerUrl: text(env.NAP_SIGNER_URL) || null,
    turn: turnKeyId && turnToken ? { keyId: turnKeyId, token: turnToken } : null,
    extensionSecrets: parseExtensionSecrets(text(env.NAP_EXTENSION_SECRETS)),
  });
}

/** A service account's JSON key, as Google Cloud downloads it. Anything else counts as none. */
export function parsePlayServiceAccount(value: string): PlayServiceAccount | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { client_email?: unknown; private_key?: unknown };
    const clientEmail = typeof parsed.client_email === "string" ? parsed.client_email : "";
    const privateKey = typeof parsed.private_key === "string" ? parsed.private_key : "";
    return clientEmail && privateKey ? { clientEmail, privateKey } : null;
  } catch {
    return null;
  }
}

/** A JSON object of strings. Anything else counts as no secrets, so pages still load. */
export function parseExtensionSecrets(value: string): Record<string, string> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/**
 * The upload and sign-in rate limiter (DRAFT_LIMITER). Without the binding, everything passes.
 */
export class RateLimiter extends Context.Service<
  RateLimiter,
  { readonly allow: (key: string) => Effect.Effect<boolean> }
>()("nap/RateLimiter") {
  static make(limiter: RateLimit | undefined): RateLimiter["Service"] {
    return RateLimiter.of({
      allow: (key) =>
        limiter
          ? Effect.promise(() => limiter.limit({ key })).pipe(Effect.map(({ success }) => success))
          : Effect.succeed(true),
    });
  }
}

/**
 * Work that may finish after the response, with the request's `ctx.waitUntil`. Without one (in
 * TanStack routes and tests), the work runs before the response instead.
 */
export class Background extends Context.Service<
  Background,
  { readonly waitUntil: ((promise: Promise<unknown>) => void) | null }
>()("nap/Background") {
  static make(ctx: Pick<ExecutionContext, "waitUntil"> | undefined): Background["Service"] {
    return Background.of({ waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : null });
  }
}

/**
 * Runs `effect` in the background, with the caller's services. Failures are logged, never sent
 * to the client.
 */
export const inBackground = <E, R>(effect: Effect.Effect<void, E, R>, label: string) =>
  Effect.gen(function* () {
    const { waitUntil } = yield* Background;
    const logged = effect.pipe(Effect.catchCause((cause) => Effect.logError(label, cause)));
    if (!waitUntil) return yield* logged;
    const context = yield* Effect.context<R>();
    waitUntil(Effect.runPromise(Effect.provideContext(logged, context)));
  });
