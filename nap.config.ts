import type { AutomaticCapability } from "~/lib/capabilities";
/**
 * What makes a Nap deployment its own: its domain and its organisation. The values live in
 * instance/config.ts, which each deployment provides (see instance.example/).
 * The app (server and browser) and the infrastructure read it. Cloud resource IDs and Access
 * settings for production are in infra/production.ts.
 *
 * Keep it free of secrets: it is bundled into the browser code.
 */
export type NapConfig = {
  /**
   * The dashboard host. Sites are served at <slug>.<rootDomain>, so the TLS certificate must
   * cover that wildcard (Universal SSL covers one level below the zone apex).
   */
  rootDomain: string;
  /** Who "everyone" means in the UI and agent docs: the people Cloudflare Access lets in. */
  orgName: string;
  /**
   * Who can see a new artifact or site until its owner changes it: "private" (only the owner) or
   * "everyone" (everyone Access lets in). Updates keep the access the owner chose.
   */
  defaultAccess: "private" | "everyone";
  /** Who agents send feature requests to. */
  admin: string;
  /**
   * Native apps. null turns them off. A Nap has one app: one source repo (app-<app>) with a
   * folder per platform, and each platform it has on gets a launcher that holds every app.
   * Today the only platform is iOS.
   */
  apps: {
    /** The app's slug on Nap. Its repo is app-<app>. */
    app: string;
    /**
     * iOS: signed by Nap and distributed through TestFlight. Leave it out for no iOS. The signing
     * certificate and the App Store Connect key are secrets (see alchemy.run.ts). The App ID,
     * the App Store profile, and the app record are made by hand in the developer account; Nap
     * never creates them.
     */
    ios?: {
      /** The Apple developer team that owns the certificate and profiles. */
      teamId: string;
      /**
       * The app record's Apple ID (App Store Connect → the app → App Information). null until
       * the app record exists: agents can work on the app, and publishing waits for it.
       */
      appStoreId: string | null;
      /** The app record's bundle id, an explicit App ID such as com.example.nap. */
      bundleId: string;
      /** The App Store provisioning profile for that bundle id, by its name. */
      profileName: string;
      /**
       * Capabilities that apps in the launcher may turn on for the App ID by declaring them in
       * app.json, such as ["push-notifications", "healthkit"]. Leave it out to allow every one
       * Nap can turn on (src/lib/capabilities.ts); [] allows none. The rest become warnings
       * inside the launcher.
       */
      capabilities?: Array<AutomaticCapability>;
    };
  } | null;
  /**
   * Example requests the dashboard rotates through under "Ask your agent", such as
   * `{ kind: "site", text: "where we vote on the offsite venue" }`. Each reads after
   * "Make me a site", "Make me an artifact", or "Make me an app". Optional: Nap has generic ones.
   */
  examples?: Array<{ kind: "site" | "artifact" | "app"; text: string }>;
};

export { napConfig } from "./instance/config.ts";
