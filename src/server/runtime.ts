import { Context, Effect, Logger, Predicate } from "effect";
import { napConfig } from "~/nap.config";
import {
  ChannelsBinding,
  LiveBinding,
  SignerBinding,
  SourceNamespaceBinding,
  type SourceNamespace,
} from "~/server/bindings";
import { Database } from "~/server/database";
import { HttpError, json } from "~/server/http";
import {
  Background,
  RateLimiter,
  Settings,
  settingsFromEnv,
  type SettingsEnv,
} from "~/server/platform";
import { Storage } from "~/server/storage";

/**
 * Runs Nap's Effect handlers. The Worker's fetch handler, the TanStack API routes, and the tests
 * all come through here: it provides the services from the Worker's bindings, turns an
 * `HttpError` into its response, and turns anything else into a logged 500.
 */

/** Every service a handler may use. */
export type NapServices =
  | Database
  | Storage
  | Settings
  | RateLimiter
  | Background
  | SourceNamespaceBinding
  | LiveBinding
  | ChannelsBinding
  | SignerBinding;

/** The bindings the services come from. Tests pass only what they use. */
export type NapEnv = SettingsEnv & {
  DB: D1Database;
  SITES?: R2Bucket;
  DRAFT_LIMITER?: RateLimit;
  SOURCES?: unknown;
  LIVE?: DurableObjectNamespace<import("~/lib/site-live").SiteLive>;
  CHANNELS?: DurableObjectNamespace<import("~/lib/site-channel").SiteChannel>;
  SIGNER?: DurableObjectNamespace<import("~/lib/app-signer").AppSigner>;
};

/**
 * Structured JSON logs, which Workers Logs indexes. Errors go to console.error and warnings to
 * console.warn, so Workers Logs sees their level.
 */
const loggers: ReadonlySet<Logger.Logger<unknown, unknown>> = new Set([
  Logger.withLeveledConsole(Logger.formatJson),
]);

/** The services that depend only on the environment, built once per environment object. */
const envServices = new WeakMap<object, Context.Context<Exclude<NapServices, Background>>>();

function servicesFor(env: NapEnv) {
  let services = envServices.get(env);
  if (!services) {
    const settings = settingsFromEnv(env, napConfig.rootDomain);
    services = Context.make(Database, Database.make(env.DB)).pipe(
      Context.add(Storage, Storage.make(env.SITES ?? missingBucket())),
      Context.add(Settings, settings),
      Context.add(RateLimiter, RateLimiter.make(env.DRAFT_LIMITER)),
      Context.add(SourceNamespaceBinding, (env.SOURCES as SourceNamespace | undefined) ?? null),
      Context.add(LiveBinding, env.LIVE ?? null),
      Context.add(ChannelsBinding, env.CHANNELS ?? null),
      Context.add(SignerBinding, SignerBinding.make(env.SIGNER, settings.signerUrl)),
    );
    envServices.set(env, services);
  }
  return services;
}

/** The full context for one request. */
export function napContext(env: NapEnv, ctx?: Pick<ExecutionContext, "waitUntil">) {
  return servicesFor(env).pipe(
    Context.add(Background, Background.make(ctx)),
    Context.add(Logger.CurrentLoggers, loggers),
  );
}

/** Runs any Nap effect with the services from `env`. Failures reject the promise. */
export function runNap<A, E>(
  env: NapEnv,
  effect: Effect.Effect<A, E, NapServices>,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  return Effect.runPromise(Effect.provideContext(effect, napContext(env, ctx)));
}

/**
 * Runs a handler and always resolves with a response: an `HttpError` becomes its response, and
 * every other failure a 500 that says nothing about the cause.
 */
export function respond<E>(
  env: NapEnv,
  handler: Effect.Effect<Response, E, NapServices>,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  return runNap(
    env,
    handler.pipe(
      Effect.catchCause((cause) => {
        const failure = cause.reasons.find((reason) => reason._tag === "Fail");
        // By tag, not instanceof: a second copy of the module must not turn 4xx into 500s.
        const error = failure?.error;
        if (Predicate.isTagged(error, "HttpError")) {
          return Effect.succeed((error as unknown as HttpError).toResponse());
        }
        return Effect.logError("Request failed", cause).pipe(
          Effect.as(
            json(
              { error: "Something went wrong. Try again." },
              { status: 500, headers: noStoreHeaders },
            ),
          ),
        );
      }),
    ),
    ctx,
  );
}

const noStoreHeaders = { "cache-control": "no-store" };

function missingBucket(): R2Bucket {
  return new Proxy({} as R2Bucket, {
    get() {
      throw new Error("The SITES bucket is not bound");
    },
  });
}
