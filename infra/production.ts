import type { ApplicationProps } from "alchemy/Cloudflare/Access";
import { napConfig } from "../nap.config.ts";

const root = napConfig.rootDomain;

export type ProductionSettings = {
  accountId: string;
  accessIssuer: string;
  zoneId: string;
  /** The zone that holds the root domain, for the Worker routes. */
  zoneName: string;
  databaseId: string;
  dns: Array<{
    name: string;
    type: "A" | "AAAA" | "CNAME";
    content: string;
    proxied: boolean;
    ttl: number;
    comment?: string;
  }>;
  /**
   * Who can sign in: emails, and "@example.com" for everyone at a domain. Nap makes them its own
   * reusable Access policy, "Nap people", and makes "Nap bypass" for the paths that skip Access.
   * People use any login method of the Zero Trust team, such as a one-time PIN or Google.
   */
  people?: string[];
  /**
   * Instead of people: the ids of existing reusable Access policies that decide who can sign in,
   * for an account that already manages its policies. Nap then makes no account policies: the
   * paths that skip Access use bypassPolicy, or an Access policy of their own application.
   */
  accessPolicies?: string[];
  /** With accessPolicies: an existing reusable bypass policy for the paths that skip Access. */
  bypassPolicy?: string;
  humanAccess: ApplicationProps | null;
};

import { production } from "../instance/production.ts";

export { production };

export function productionSettings(config = production, rootDomain = root): ProductionSettings {
  const names = new Set(config.dns.map((record) => record.name));
  const protectedPaths = new Set([
    config.humanAccess?.domain,
    ...(config.humanAccess?.destinations ?? []).flatMap((destination) =>
      destination.type === "public" ? [destination.uri] : [],
    ),
  ]);
  if (
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.accessIssuer) ||
    config.dns.length !== 2 ||
    !names.has(rootDomain) ||
    !names.has(`*.${rootDomain}`) ||
    !(rootDomain === config.zoneName || rootDomain.endsWith(`.${config.zoneName}`)) ||
    config.dns.some(
      (record) =>
        !record.proxied ||
        !record.content ||
        record.ttl !== 1 ||
        !["A", "AAAA", "CNAME"].includes(record.type),
    ) ||
    !config.humanAccess ||
    config.humanAccess.type !== "self_hosted" ||
    // Either people or accessPolicies decides who can sign in.
    !config.people?.length === !config.accessPolicies?.length ||
    (config.bypassPolicy && !config.accessPolicies?.length) ||
    ![rootDomain, `${rootDomain}/*`].some((path) => protectedPaths.has(path)) ||
    ![`*.${rootDomain}`, `*.${rootDomain}/*`].some((path) => protectedPaths.has(path))
  ) {
    throw new Error("Invalid production settings in infra/production.ts");
  }
  return config;
}
