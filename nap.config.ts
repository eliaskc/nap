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
   * Native iOS apps, signed by Nap and distributed through TestFlight. null turns apps off. The
   * signing certificate and the App Store Connect key are secrets (see alchemy.run.ts). Nap has
   * one app: its launcher goes to an app record in App Store Connect, and its internal testers
   * install it from the TestFlight app. The App ID, the App Store profile, and the app record are
   * made by hand in the developer account; Nap never creates them.
   */
  apps: {
    /** The Apple developer team that owns the certificate and profiles. */
    teamId: string;
    testFlight: {
      /** The app record's Apple ID (App Store Connect → the app → App Information). */
      appStoreId: string;
      /** The app record's bundle id, an explicit App ID such as com.example.nap. */
      bundleId: string;
      /** The App Store provisioning profile for that bundle id, by its name. */
      profileName: string;
      /** The app on Nap (its slug) whose launcher goes to TestFlight: the only app. */
      app: string;
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
