import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { napConfig } from "./nap.config.ts";
import { productionSettings } from "./infra/production.ts";
import type { AppSigner } from "./src/lib/app-signer.ts";
import type { SiteChannel } from "./src/lib/site-channel.ts";
import type { SiteLive } from "./src/lib/site-live.ts";

const ROOT_DOMAIN = napConfig.rootDomain;

export const Database = Cloudflare.D1.Database(
  "Database",
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    return {
      name: stage === "prod" ? "nap" : `nap-${stage}`,
      // Alchemy imports Wrangler's applied migration history before applying new SQL.
      migrations: "./migrations",
    };
  }),
).pipe(RemovalPolicy.retain());

export const Sites = Cloudflare.R2.Bucket(
  "Sites",
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    return {
      name: stage === "prod" ? "nap-sites" : `nap-sites-${stage}`,
      forceDestroy: false,
      // No public domain. Only the Nap Worker serves objects.
      domains: [],
      // Direct uploads: the dashboard PUTs files to presigned R2 URLs from the browser.
      cors: [
        {
          id: "dashboard-direct-uploads",
          allowedMethods: ["PUT" as const],
          allowedOrigins: [`https://${ROOT_DOMAIN}`],
          allowedHeaders: ["content-type"],
          maxAgeSeconds: 3600,
        },
      ],
      lifecycleRules: [
        {
          // Unclaimed agent drafts. Published drafts are copied to sites/ and deleted.
          id: "delete-agent-drafts",
          prefix: "drafts/",
          deleteObjectsTransition: {
            condition: { type: "Age" as const, maxAge: 60 * 60 * 24 * 2 },
          },
        },
        {
          // Extensions' caches (nap.extension.ts). They decide themselves how old is too old.
          id: "delete-extension-caches",
          prefix: "extension-cache/",
          deleteObjectsTransition: {
            condition: { type: "Age" as const, maxAge: 60 * 60 * 24 * 7 },
          },
        },
      ],
    };
  }),
).pipe(RemovalPolicy.retain());

// Access policies are reusable account policies, attached to the applications below.
// Everyone: Access lets the request through, and the Worker checks its own credential.
export const Bypass = Cloudflare.Access.Policy("Bypass", {
  name: "Nap bypass",
  decision: "bypass",
  include: ["everyone"],
}).pipe(RemovalPolicy.retain());

// The people in instance/production.ts: emails, and "@domain" for everyone at a domain. They sign
// in with any login method of the Zero Trust team (one-time PIN, Google, ...).
export const People = Cloudflare.Access.Policy("People", {
  name: "Nap people",
  decision: "allow",
  include: (productionSettings().people ?? []).map((entry) =>
    entry.startsWith("@") ? { emailDomain: entry.slice(1) } : { email: entry },
  ),
}).pipe(RemovalPolicy.retain());

/**
 * The policies of an application whose path skips Access: "Nap bypass", or with accessPolicies
 * the given bypassPolicy or a bypass policy of the application's own.
 */
function bypassPolicies(app: string) {
  return Effect.gen(function* () {
    const settings = productionSettings();
    if (!settings.accessPolicies?.length) return [yield* Bypass];
    if (settings.bypassPolicy) return [{ id: settings.bypassPolicy, precedence: 1 }];
    return [{ name: `bypass-${app}`, decision: "bypass" as const, include: ["everyone" as const] }];
  });
}

// Agents upload drafts without a login. Access must bypass exactly this path; the Worker
// stores drafts without serving them until a signed-in person claims them.
export const DraftUploadAccess = Cloudflare.Access.Application(
  "DraftUploadAccess",
  Effect.gen(function* () {
    return {
      type: "self_hosted" as const,
      name: "nap-agent-drafts",
      domain: `${ROOT_DOMAIN}/_nap/drafts`,
      policies: yield* bypassPolicies("nap-agent-drafts"),
      appLauncherVisible: false,
    };
  }),
).pipe(RemovalPolicy.retain());

// The agent API. Agents send a Nap token, not an Access session, so Access must bypass this
// path. The Worker checks the token on every request. Tokens come from /connect, which Access
// protects, so only people that Access allows can get one.
export const AgentApiAccess = Cloudflare.Access.Application(
  "AgentApiAccess",
  Effect.gen(function* () {
    return {
      type: "self_hosted" as const,
      name: "nap-agent-api",
      domain: `${ROOT_DOMAIN}/_nap/api/*`,
      policies: yield* bypassPolicies("nap-agent-api"),
      appLauncherVisible: false,
    };
  }),
).pipe(RemovalPolicy.retain());

// Artifact frames. <root>/artifact/<slug> frames the artifact in a sandbox with an opaque origin,
// and requests from that origin may not carry the Access cookie. The frame loads its files from
// <root>/_nap/frame/<token>/ instead. Only the Access-protected artifact page makes tokens; the
// Worker checks the token and the viewer's access on every request.
export const ArtifactFrameAccess = Cloudflare.Access.Application(
  "ArtifactFrameAccess",
  Effect.gen(function* () {
    return {
      type: "self_hosted" as const,
      name: "nap-artifact-frames",
      domain: `${ROOT_DOMAIN}/_nap/frame/*`,
      policies: yield* bypassPolicies("nap-artifact-frames"),
      appLauncherVisible: false,
    };
  }),
).pipe(RemovalPolicy.retain());

export const DraftLimiter = Cloudflare.RateLimit("DRAFT_LIMITER", {
  namespaceId: 1001,
  simple: { limit: 20, period: 60 },
});

export class NapWorker extends Cloudflare.Website.Vite<NapWorker>()(
  "Worker",
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const production = stage === "prod";
    // Direct uploads sign R2 URLs with an R2 API token that can only read and write objects in
    // the Nap bucket. Deploys read its S3 credentials from the environment (GitHub secrets in
    // CI). Other stages leave them empty, and Nap falls back to uploads through the Worker.
    // Local stages may set all four from the environment: the HTTP tests use fake values.
    const secret = (name: string) => Effect.orDie(Config.Redacted(name));
    const local = (name: string) =>
      isLocalStage()
        ? Effect.orDie(Config.String(name).pipe(Config.withDefault("")))
        : Effect.succeed("");
    const r2AccessKeyId = production
      ? yield* secret("NAP_R2_ACCESS_KEY_ID")
      : yield* local("NAP_R2_ACCESS_KEY_ID");
    const r2SecretAccessKey = production
      ? yield* secret("NAP_R2_SECRET_ACCESS_KEY")
      : yield* local("NAP_R2_SECRET_ACCESS_KEY");
    const devPort = Number(yield* local("NAP_DEV_PORT")) || undefined;
    // iOS apps (napConfig.apps.ios): the Apple Distribution key and certificate (one PEM) that the
    // signer container signs with, and the App Store Connect team key that reads the profile.
    // Production reads them from the environment. Other stages may set them; without them,
    // publishing a build fails with a clear error.
    const optional = (name: string) =>
      Effect.orDie(Config.Redacted(name).pipe(Config.withDefault(Redacted.make(""))));
    const appsInProduction = production && Boolean(napConfig.apps?.ios);
    const plain = (name: string) => Effect.orDie(Config.String(name).pipe(Config.withDefault("")));
    const appSigningPem = appsInProduction
      ? yield* secret("NAP_APPLE_SIGNING_PEM")
      : yield* optional("NAP_APPLE_SIGNING_PEM");
    const ascPrivateKey = appsInProduction
      ? yield* secret("NAP_ASC_PRIVATE_KEY")
      : yield* optional("NAP_ASC_PRIVATE_KEY");
    // Notifications to the iOS app: an APNs key. Optional; without it, only browsers get them.
    const apnsPrivateKey = yield* optional("NAP_APNS_PRIVATE_KEY");
    // Voice and video between the people on a nap (/_nap/rtc): a Cloudflare Realtime TURN key.
    // Optional on every stage; without it, pages get STUN only, which fails on some networks.
    const turnKeyToken = yield* optional("NAP_TURN_KEY_API_TOKEN");
    // The deployment's extension secrets (nap.extension.ts): one JSON object of strings, such as
    // {"AMPLITUDE_API_KEY": "..."}. Optional on every stage; an extension without its secrets
    // answers that it is not set up.
    const extensionSecrets = yield* optional("NAP_EXTENSION_SECRETS");
    return {
      name: production ? "nap" : `nap-${stage}`,
      main: "./src/worker.ts",
      workersDev: { enabled: false, previewsEnabled: false },
      // `alchemy dev` serves on 1337 or the next free port. The HTTP tests pick their own port.
      dev: devPort ? { port: devPort, strictPort: true } : undefined,
      // Preserve host-based routing, including all hosted site subdomains.
      routes: production
        ? [
            { pattern: `${ROOT_DOMAIN}/*`, zoneName: productionSettings().zoneName },
            { pattern: `*.${ROOT_DOMAIN}/*`, zoneName: productionSettings().zoneName },
          ]
        : [],
      compatibility: { date: "2026-06-13", flags: ["nodejs_compat"] },
      assets: { runWorkerFirst: true },
      env: {
        DB: Database,
        SITES: Sites,
        DRAFT_LIMITER: DraftLimiter,
        // Live collection updates: one object per site, holding only WebSockets. Exported by
        // src/worker.ts; Alchemy adds the SQLite class migration.
        LIVE: Cloudflare.DurableObject<SiteLive>("LIVE", { className: "SiteLive" }),
        // Multiplayer channels: one object per site and channel name, holding only WebSockets.
        CHANNELS: Cloudflare.DurableObject<SiteChannel>("CHANNELS", { className: "SiteChannel" }),
        // Channel servers (napConfig.channelServers, and always on local stages): loads a site's
        // server code into its channel object as a sandboxed Dynamic Worker. Dynamic Workers
        // need the Workers Paid plan.
        ...(napConfig.channelServers || isLocalStage()
          ? { LOADER: Cloudflare.WorkerLoader("LOADER") }
          : {}),
        // The app signer: a container that signs unsigned iOS builds with rcodesign
        // (containers/signer). One instance that sleeps when idle; it has no internet access.
        // standard-1 (half a CPU, 4 GB): lite took two minutes to sign a 19 MB app.
        // Only with iOS on (napConfig.apps.ios): containers need the Workers Paid plan and Docker.
        // Turning iOS off on a Nap that had it fails to deploy while the Worker still exports
        // AppSigner (Cloudflare refuses the deleted class).
        ...(napConfig.apps?.ios
          ? {
              SIGNER: Cloudflare.Container<AppSigner>("SIGNER", {
                className: "AppSigner",
                context: "./containers/signer",
                instanceType: "standard-1",
                maxInstances: 1,
              }),
            }
          : {}),
        // Source repos: one Cloudflare Artifacts repo per site that keeps its source in Nap.
        // Repos are created at runtime; the namespace needs no provisioning.
        // Local stages may name another namespace: the source repo test uses a test namespace.
        SOURCES: yield* Cloudflare.Artifacts.Namespace("Sources", {
          namespace: production
            ? "nap-sites"
            : (yield* local("NAP_SOURCES_NAMESPACE")) || `nap-sites-${namespaceSuffix(stage)}`,
        }),
        NAP_ROOT_DOMAIN: ROOT_DOMAIN,
        NAP_R2_ACCOUNT_ID: production
          ? productionSettings().accountId
          : yield* local("NAP_R2_ACCOUNT_ID"),
        NAP_R2_BUCKET: production ? "nap-sites" : yield* local("NAP_R2_BUCKET"),
        NAP_R2_ACCESS_KEY_ID: r2AccessKeyId,
        NAP_R2_SECRET_ACCESS_KEY: r2SecretAccessKey,
        // Local stages only: sign with the signer image run by plain Docker at this URL, for
        // Docker engines where workerd's local containers do not start (such as OrbStack).
        NAP_SIGNER_URL: yield* local("NAP_SIGNER_URL"),
        NAP_APPLE_SIGNING_PEM: appSigningPem,
        NAP_ASC_PRIVATE_KEY: ascPrivateKey,
        NAP_ASC_KEY_ID: yield* plain("NAP_ASC_KEY_ID"),
        NAP_ASC_ISSUER_ID: yield* plain("NAP_ASC_ISSUER_ID"),
        NAP_APNS_PRIVATE_KEY: apnsPrivateKey,
        NAP_APNS_KEY_ID: yield* plain("NAP_APNS_KEY_ID"),
        NAP_TURN_KEY_ID: yield* plain("NAP_TURN_KEY_ID"),
        NAP_TURN_KEY_API_TOKEN: turnKeyToken,
        NAP_EXTENSION_SECRETS: extensionSecrets,
      },
      observability: { enabled: true },
    };
  }),
) {}

export type NapWorkerEnv = Cloudflare.InferEnv<typeof NapWorker>;

/** Artifacts namespaces allow lowercase letters, digits, and hyphens. */
function namespaceSuffix(stage: string) {
  return (
    stage
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "dev"
  );
}

/** Stages named local* run only on this machine. The CLI passes its options in ALCHEMY_EXEC_OPTIONS. */
function isLocalStage() {
  let stage: unknown;
  try {
    stage = JSON.parse(process.env.ALCHEMY_EXEC_OPTIONS ?? "{}").stage;
  } catch {}
  if (typeof stage !== "string") {
    const argument = process.argv.indexOf("--stage");
    stage = argument >= 0 ? process.argv[argument + 1] : process.env.ALCHEMY_STAGE;
  }
  return typeof stage === "string" && stage.startsWith("local");
}

export default Alchemy.Stack(
  "Nap",
  {
    providers: Cloudflare.providers(),
    // The account's Alchemy state store. Local stages
    // keep their state on this machine, so local dev and tests need no Cloudflare login.
    state: isLocalStage() ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    if (stage === "prod") {
      const settings = productionSettings();
      // Use the reviewed live records, not guessed DNS targets or Access policies.
      for (const record of settings.dns) {
        yield* Cloudflare.DNS.Record(record.name.startsWith("*.") ? "SitesDns" : "DashboardDns", {
          zoneId: settings.zoneId,
          name: record.name,
          type: record.type,
          content: record.content,
          proxied: true,
          ttl: record.ttl,
          comment: record.comment,
        }).pipe(RemovalPolicy.retain());
      }
      yield* Cloudflare.Access.Application("HumanAccess", {
        ...settings.humanAccess!,
        policies: settings.accessPolicies?.length
          ? settings.accessPolicies.map((id, index) => ({ id, precedence: index + 1 }))
          : [yield* People],
      }).pipe(RemovalPolicy.retain());
      yield* DraftUploadAccess;
      yield* AgentApiAccess;
      yield* ArtifactFrameAccess;
    }
    const worker = yield* NapWorker.pipe(RemovalPolicy.retain());
    const database = yield* Database;
    const bucket = yield* Sites;
    return {
      workerName: worker.workerName,
      databaseId: database.databaseId,
      bucketName: bucket.bucketName,
    };
  }),
);
