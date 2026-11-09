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
   * The platforms are iOS, Android, and reMarkable.
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
    /**
     * Android: signed by Nap with the Play upload key and distributed through Google Play's
     * internal testing track. Leave it out for no Android. The upload key and the Play service
     * account are secrets (see alchemy.run.ts). The app in Play Console is made by hand; Nap
     * never creates it.
     */
    android?: {
      /** The app's package name in Play Console, such as com.example.nap. */
      packageName: string;
      /**
       * The internal testing opt-in link (Play Console → Test and release → Internal testing →
       * Testers → How testers join your test). null until the app exists: agents can work on the
       * app and publish, and the dashboard shows how to get it once this is set.
       */
      testersUrl: string | null;
      /**
       * Notifications to Android phones (with `notifications` on): the Firebase app for this
       * package, from its google-services.json. These identify the app and are not secret; the
       * launcher gets them from Nap. Nap sends through Firebase Cloud Messaging as the Play
       * service account, which needs the role Firebase Cloud Messaging API Admin in this project.
       * Leave it out for no notifications on Android.
       */
      firebase?: {
        /** project_info.project_id */
        projectId: string;
        /** project_info.project_number */
        senderId: string;
        /** client[].client_info.mobilesdk_app_id */
        appId: string;
        /** client[].api_key[].current_key */
        apiKey: string;
      };
    };
    /**
     * reMarkable: a launcher for the reMarkable 2 tablet, run by AppLoad. Leave it out for no
     * reMarkable. Nap stores the zipped AppLoad folder as it is uploaded; tablets sign in with a
     * Nap token and update themselves from it. Nothing to set up: `{}` turns it on.
     */
    remarkable?: Record<string, never>;
  } | null;
  /**
   * Notifications: pages and apps send them with nap.notify, to everyone else who can see the
   * page. Browsers get them once the person turns them on (the bell in the dashboard's bar); the
   * iOS app gets them when the deployment has an APNs key (NAP_APNS_KEY_ID and
   * NAP_APNS_PRIVATE_KEY). Off when left out.
   */
  notifications?: boolean;
  /**
   * Channel servers: a site may name JavaScript in its nap.json that Nap runs for a channel, as
   * the authoritative host of a multiplayer game (src/lib/site-channel.ts). It runs in a Dynamic
   * Worker, which needs the Workers Paid plan. Off when left out.
   */
  channelServers?: boolean;
  /**
   * Avatars: everyone has a look (a shape and a colour, src/lib/looks.ts) that they pick on the
   * welcome page, the dashboard shows, and sites and apps draw them with (nap.me(), nap.people(),
   * channel presence). Off, nobody has one: people only pick a name, shape and color are null,
   * and the agent instructions leave looks out. Off when left out.
   */
  avatars?: boolean;
  /**
   * Example requests the dashboard rotates through under "Ask your agent", such as
   * `{ kind: "site", text: "where we vote on the offsite venue" }`. Each reads after
   * "Make me a site", "Make me an artifact", or "Make me an app". Optional: Nap has generic ones.
   */
  examples?: Array<{ kind: "site" | "artifact" | "app"; text: string }>;
};

export { napConfig } from "./instance/config.ts";
