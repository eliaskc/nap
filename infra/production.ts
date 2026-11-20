import type { ApplicationProps } from "@alchemy.run/cloudflare/Access";
import { napConfig } from "../nap.config.ts";

const root = napConfig.rootDomain;
const contentDomain = napConfig.contentDomain || root;

export type DnsRecordSettings = {
  name: string;
  type: "A" | "AAAA" | "CNAME";
  content: string;
  proxied: boolean;
  ttl: number;
  comment?: string;
};

export type ProductionSettings = {
  accountId: string;
  accessIssuer: string;
  zoneId: string;
  /** The zone that holds the root domain, for the Worker routes. */
  zoneName: string;
  databaseId: string;
  dns: Array<DnsRecordSettings>;
  /**
   * The zone of a separate content domain (napConfig.contentDomain), where naps on their own
   * host run: two proxied DNS records, <content> and *.<content>. Nap adds the Worker routes and
   * an Access application for it ("nap-content", same policies and session length as
   * humanAccess). Leave it out when the content domain is the root domain.
   */
  content?: {
    zoneId: string;
    /** The zone that holds the content domain. */
    zoneName: string;
    dns: Array<DnsRecordSettings>;
  };
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

export function productionSettings(
  config = production,
  rootDomain = root,
  content = contentDomain,
): ProductionSettings {
  const names = new Set(config.dns.map((record) => record.name));
  const separate = content !== rootDomain;
  const contentNames = new Set(config.content?.dns.map((record) => record.name));
  const badRecord = (record: DnsRecordSettings) =>
    !record.proxied ||
    !record.content ||
    record.ttl !== 1 ||
    !["A", "AAAA", "CNAME"].includes(record.type);
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
    config.dns.some(badRecord) ||
    // A separate content domain is its own registrable domain, with its own zone and records.
    (separate &&
      (!config.content ||
        content === rootDomain ||
        // Not in the root's zone: its cookies would reach the root's site again.
        content === config.zoneName ||
        content.endsWith(`.${config.zoneName}`) ||
        rootDomain.endsWith(`.${content}`) ||
        !(content === config.content.zoneName || content.endsWith(`.${config.content.zoneName}`)) ||
        config.content.dns.length !== 2 ||
        !contentNames.has(content) ||
        !contentNames.has(`*.${content}`) ||
        config.content.dns.some(badRecord))) ||
    (!separate && config.content) ||
    !config.humanAccess ||
    config.humanAccess.type !== "self_hosted" ||
    // Either people or accessPolicies decides who can sign in.
    !config.people?.length === !config.accessPolicies?.length ||
    (config.bypassPolicy && !config.accessPolicies?.length) ||
    ![rootDomain, `${rootDomain}/*`].some((path) => protectedPaths.has(path)) ||
    ![`*.${rootDomain}`, `*.${rootDomain}/*`].some((path) => protectedPaths.has(path)) ||
    // The content domain has an application of its own (contentAccess), with its own audience.
    (separate &&
      [...protectedPaths].some(
        (path) => path && (path.startsWith(`${content}/`) || path.includes(`.${content}/`)),
      ))
  ) {
    throw new Error("Invalid production settings in infra/production.ts");
  }
  return config;
}

/**
 * The Access application of a separate content domain: <content>/* and *.<content>/*, with the
 * policies, session length, and login methods of humanAccess, so the same people sign in the same
 * way. It has its own audience tag, which the Worker checks on every content request, so a session
 * on one domain never counts on the other. Its cookie is HttpOnly, so naps cannot read it, and
 * SameSite=Lax, so links from the dashboard (another site) arrive signed in but other sites cannot
 * send it along with their own requests. Null without a separate content domain.
 */
export function contentAccess(
  config: ProductionSettings,
  content = contentDomain,
): ApplicationProps | null {
  if (!config.content || !config.humanAccess) return null;
  const human = config.humanAccess;
  return {
    type: "self_hosted",
    name: `${human.name ?? "nap"}-content`,
    domain: `${content}/*`,
    destinations: [
      { type: "public", uri: `${content}/*` },
      { type: "public", uri: `*.${content}/*` },
    ],
    sessionDuration: human.sessionDuration,
    ...(human.allowedIdps ? { allowedIdps: human.allowedIdps } : {}),
    autoRedirectToIdentity: human.autoRedirectToIdentity,
    appLauncherVisible: false,
    httpOnlyCookieAttribute: true,
    sameSiteCookieAttribute: "lax",
  };
}
