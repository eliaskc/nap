import { execFileSync } from "node:child_process";
import { productionSettings } from "../../infra/production.ts";

process.env.ALCHEMY_PROFILE ??= "nap";
const mode = process.argv[2];
if (!["plan", "deploy", "adopt"].includes(mode)) throw new Error("Expected plan, deploy, or adopt");
const config = productionSettings();
if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== config.accountId)
  throw new Error("Wrong Cloudflare account");
// Confirm storage, privacy, and the existing shared state store before Alchemy runs.
execFileSync(process.execPath, ["scripts/infra/inventory.mjs"], {
  stdio: "inherit",
  env: process.env,
});
const args = ["exec", "alchemy", "deploy", "--stage", "prod"];
if (mode === "plan") args.push("--dry-run", "--adopt");
if (mode === "adopt") args.push("--adopt");
// No --yes: review Alchemy's plan before applying it.
execFileSync("pnpm", args, { stdio: "inherit", env: process.env });
