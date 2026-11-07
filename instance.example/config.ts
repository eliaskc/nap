import type { NapConfig } from "../nap.config.ts";

export const napConfig: NapConfig = {
  rootDomain: "nap.example.com",
  orgName: "Example",
  defaultAccess: "private",
  admin: "the Nap admin",
  // Native iOS apps through TestFlight: { teamId, testFlight: { appStoreId, bundleId, profileName,
  // app } }, or null to turn them off.
  apps: null,
};
