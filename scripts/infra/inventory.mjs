// Read-only cloud inspection. This script never creates or updates resources.
import { mkdir, writeFile } from "node:fs/promises";
import { production as expected } from "../../infra/production.ts";
import { napConfig } from "../../nap.config.ts";
import { cloudflareAuth } from "./auth.ts";
process.env.CI ??= "true";
const root = napConfig.rootDomain;

const { accountId: account, headers } = await cloudflareAuth();
if (account !== expected.accountId)
  throw new Error("The Alchemy profile is not using the account in infra/production.ts");
if (!expected.databaseId) {
  // A new instance: nothing exists yet. Put the database id from the first deploy in production.ts.
  console.log("No databaseId yet: first deploy, nothing to inspect.");
  process.exit(0);
}
const base = `accounts/${account}`;
async function get(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    headers,
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Read permission or resource missing: ${path} (HTTP ${response.status})`);
  const body = await response.json();
  if (!body.success) throw new Error(`Cloudflare rejected the read: ${path}`);
  return body.result;
}
const [
  database,
  bucket,
  bypass,
  worker,
  stateStore,
  routes,
  org,
  apps,
  rootDns,
  wildcardDns,
  publicBucket,
  bucketDomains,
] = await Promise.all([
  get(`${base}/d1/database/${expected.databaseId}`),
  get(`${base}/r2/buckets/nap-sites`),
  get(`${base}/workers/scripts/nap/subdomain`),
  get(`${base}/workers/scripts/nap/settings`),
  get(`${base}/workers/scripts/alchemy-state-store/settings`),
  get(`zones/${expected.zoneId}/workers/routes`),
  get(`${base}/access/organizations`),
  get(`${base}/access/apps?per_page=100`),
  get(`zones/${expected.zoneId}/dns_records?name=${root}`),
  get(`zones/${expected.zoneId}/dns_records?name=*.${root}`),
  get(`${base}/r2/buckets/nap-sites/domains/managed`),
  get(`${base}/r2/buckets/nap-sites/domains/custom`),
]);
if (database.name !== "nap" || database.uuid !== expected.databaseId || bucket.name !== "nap-sites")
  throw new Error("Live storage does not match the expected resource IDs");
if (
  bypass.enabled ||
  bypass.previews_enabled ||
  publicBucket.enabled ||
  bucketDomains.domains?.length
)
  throw new Error("Unexpected public bypass URL is enabled");
if (
  !worker.bindings?.some(
    (b) => b.type === "d1" && b.name === "DB" && b.id === expected.databaseId,
  ) ||
  !worker.bindings?.some(
    (b) => b.type === "r2_bucket" && b.name === "SITES" && b.bucket_name === "nap-sites",
  )
)
  throw new Error("Worker storage bindings do not match");
const dns = [...rootDns, ...wildcardDns].filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
if (dns.length !== 2 || dns.some((r) => !r.proxied))
  throw new Error("Expected one proxied DNS record for each Nap hostname");
const napHosts = [root, `*.${root}`, `${root}/*`, `*.${root}/*`];
const humanApps = apps.filter(
  (a) => napHosts.includes(a.domain) || a.destinations?.some((d) => napHosts.includes(d.uri)),
);
if (humanApps.length !== 1)
  throw new Error(
    "Review live Access topology: expected one human application protecting Nap and its sites. Do not replace shared applications.",
  );
const policies = await get(`${base}/access/apps/${humanApps[0].id}/policies`);
await mkdir("backups", { recursive: true, mode: 0o700 });
const path = `backups/infra-${new Date().toISOString().replaceAll(":", "-")}.json`;
await writeFile(
  path,
  JSON.stringify(
    {
      database,
      bucket,
      bypass,
      worker,
      stateStore,
      routes,
      org,
      humanApps,
      policies,
      dns,
      publicBucket,
      bucketDomains,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  `Inventory saved to ${path}. Compare with infra/production.ts before applying changes. No cloud changes were made.`,
);
