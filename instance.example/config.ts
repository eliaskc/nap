import type { NapConfig } from "../nap.config.ts";

export const napConfig: NapConfig = {
  rootDomain: "nap.example.com",
  // Naps on their own host run their own code, so they can set cookies for their parent domain:
  // on nap.example.com that is every host of example.com. A separate registrable domain keeps
  // them away from it: they then run at <name>.exampleusercontent.com, and old
  // <name>.nap.example.com links redirect there. Without it, they run at <name>.<rootDomain>.
  // Also set `content` in production.ts.
  // contentDomain: "exampleusercontent.com",
  orgName: "Example",
  defaultAccess: "private",
  admin: "the Nap admin",
  // Native apps: { app, ios: { teamId, appStoreId, bundleId, profileName } }, or null to turn
  // them off.
  apps: null,
};
