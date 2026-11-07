import type { NapConfig } from "../nap.config.ts";

export const napConfig: NapConfig = {
  rootDomain: "nap.example.com",
  orgName: "Example",
  defaultAccess: "private",
  admin: "the Nap admin",
  // Native apps: { app, ios: { teamId, appStoreId, bundleId, profileName } }, or null to turn
  // them off.
  apps: null,
};
