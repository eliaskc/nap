import test from "node:test";
import assert from "node:assert/strict";
import { napConfig } from "../nap.config.ts";
import { production as settings, productionSettings } from "../infra/production.ts";

const root = napConfig.rootDomain;

const complete = () => ({
  ...structuredClone(settings),
  accessIssuer: "https://example.cloudflareaccess.com",
  dns: [
    { name: root, type: "AAAA", content: "100::", proxied: true, ttl: 1 },
    { name: `*.${root}`, type: "AAAA", content: "100::", proxied: true, ttl: 1 },
  ],
});

test("production requires reviewed proxied DNS records for both hostnames", () => {
  // Until the account is set up, the real settings must refuse to deploy.
  if (!settings.accessIssuer)
    assert.throws(() => productionSettings(), /Invalid production settings/);
  else assert.equal(productionSettings(), settings);
  assert.throws(
    () => productionSettings({ ...complete(), dns: [] }),
    /Invalid production settings/,
  );
  const config = complete();
  assert.equal(productionSettings(config), config);
  config.dns[1].proxied = false;
  assert.throws(() => productionSettings(config), /Invalid production settings/);
});

test("production cannot omit wildcard Access protection or people", () => {
  const config = complete();
  config.humanAccess.destinations = [{ type: "public", uri: `${root}/*` }];
  assert.throws(() => productionSettings(config), /Invalid production settings/);
  config.humanAccess = complete().humanAccess;
  config.people = [];
  assert.throws(() => productionSettings(config), /Invalid production settings/);
});
