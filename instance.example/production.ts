import type { ProductionSettings } from "../infra/production.ts";
import { napConfig } from "./config.ts";

const root = napConfig.rootDomain;

/**
 * The production Cloudflare resources of this deployment: account, zone, DNS, and the Access
 * application that protects the dashboard and every nap. The domain is napConfig.rootDomain.
 * With a separate content domain (napConfig.contentDomain), also its zone and records in
 * `content`; Nap adds its Worker routes and its own Access application, "nap-content".
 */
export const production: ProductionSettings = {
  accountId: "0123456789abcdef0123456789abcdef",
  zoneId: "0123456789abcdef0123456789abcdef",
  zoneName: "example.com",
  accessIssuer: "https://example.cloudflareaccess.com",
  databaseId: "" /* fill in after the first deploy */,
  dns: [root, `*.${root}`].map((name) => ({
    name,
    type: "AAAA",
    content: "100::",
    proxied: true,
    ttl: 1,
    comment: "Nap: the dashboard and its naps, served by the nap Worker.",
  })),
  // With napConfig.contentDomain: the content domain's zone, and its two proxied records.
  // content: {
  //   zoneId: "0123456789abcdef0123456789abcdef",
  //   zoneName: "exampleusercontent.com",
  //   dns: ["exampleusercontent.com", "*.exampleusercontent.com"].map((name) => ({
  //     name,
  //     type: "AAAA",
  //     content: "100::",
  //     proxied: true,
  //     ttl: 1,
  //     comment: "Nap: naps on their own host, served by the nap Worker.",
  //   })),
  // },
  // Emails, and "@example.com" for everyone at a domain.
  people: ["you@example.com"],
  // Its policy is the reusable "Nap people" policy in alchemy.run.ts, built from people.
  humanAccess: {
    type: "self_hosted",
    name: "nap",
    domain: `${root}/*`,
    destinations: [
      { type: "public", uri: `${root}/*` },
      { type: "public", uri: `*.${root}/*` },
    ],
    sessionDuration: "720h",
    appLauncherVisible: false,
    autoRedirectToIdentity: false,
  },
};
