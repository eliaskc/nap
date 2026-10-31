// Runs Nap locally for the HTTP tests: `alchemy dev` on a new local stage, so every run gets its
// own D1 database (with all migrations), R2 bucket, and Durable Objects in workerd. Local stages
// keep their Alchemy state in .alchemy/ and never call the Cloudflare API, so no login is needed.
//
// The tests also read and write D1 and R2 directly. They do that through the platform proxy of
// Alchemy's Cloudflare runtime: a second workerd that binds the same local database and bucket.
import { spawn } from "node:child_process";
import { production } from "../../infra/production.ts";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { D1, R2Bucket } from "@alchemy.run/cloudflare-runtime/core/bindings";
import { getPlatformProxy } from "@alchemy.run/cloudflare-runtime/core/platform-proxy";

const ALCHEMY = join(".alchemy");

/**
 * Starts Nap on `port`. `vars` are the NAP_* values local stages read from the environment.
 * Local resources need no credentials. Pass an Alchemy `profile` when the stage uses a remote
 * binding (SOURCES, Artifacts). Returns helpers for direct D1/R2 access and `stop()`, which
 * removes the stage again.
 */
export async function startLocalNap({
  port,
  vars = {},
  label = "test",
  profile,
  timeout = 120_000,
}) {
  const stage = `local-${label}-${process.pid}`;
  // Alchemy's launcher runs the stack under Bun when it sees Bun's or pnpm's markers.
  const env = { ...process.env };
  delete env.npm_execpath;
  delete env.npm_config_user_agent;
  // CI=1: Alchemy takes Cloudflare credentials from the environment, without prompts.
  Object.assign(env, { CI: "1", NAP_DEV_PORT: String(port), ...vars });
  env.CLOUDFLARE_ACCOUNT_ID ||= production.accountId || "0".repeat(32);
  // Without a profile: a placeholder token, which local resources never use.
  if (!profile) env.CLOUDFLARE_API_TOKEN = "local";
  const credentials = profile ? ["--profile", profile] : [];
  const alchemy = (command) =>
    spawn("node", ["node_modules/alchemy/bin/cli.js", command, "--stage", stage, ...credentials], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

  const dev = alchemy("dev");
  let output = "";
  let proxy;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`alchemy dev timed out:\n${output}`)),
        timeout,
      );
      for (const stream of [dev.stdout, dev.stderr])
        stream.on("data", (chunk) => {
          output += chunk.toString();
          if (process.env.NAP_TEST_DEBUG) process.stderr.write(chunk);
          if (/Done: \d+ succeeded/.test(output)) {
            clearTimeout(timer);
            resolve();
          } else if (/apply failed|Done: .*failed/.test(output)) {
            clearTimeout(timer);
            reject(new Error(`alchemy dev failed:\n${output}`));
          }
        });
      dev.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`alchemy dev exited ${code}:\n${output}`));
      });
    });

    const { databaseId, bucketName } = await stackOutput(stage);
    proxy = await getPlatformProxy({
      bindings: [
        D1.local({ binding: "DB", id: databaseId }),
        R2Bucket.local({ binding: "SITES", id: bucketName }),
      ],
      persist: { directory: join(ALCHEMY, "local") },
    });
  } catch (error) {
    await stopProcess(dev);
    await removeStage(stage);
    throw error;
  }
  const { DB, SITES } = proxy.env;

  return {
    stage,
    /** Runs SQL against the stage's local D1 database. */
    sql: (query, ...params) =>
      DB.prepare(query)
        .bind(...params)
        .run(),
    /** Writes an object to the stage's local R2 bucket. */
    put: (key, body) => SITES.put(key, body),
    /** Whether the stage's local R2 bucket has `key`. */
    has: async (key) => (await SITES.head(key)) !== null,
    async stop() {
      await proxy.dispose().catch(() => {});
      await stopProcess(dev);
      await removeStage(stage);
    },
  };
}

/** The stage's outputs. Alchemy prints "Done" a moment before it writes them. */
async function stackOutput(stage) {
  const file = join(ALCHEMY, "state", "Nap", stage, "__stack_output__.json");
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function stopProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* stopped */
  }
}

/**
 * Forgets the stage. Its database and bucket files stay in .alchemy/local under ids no later
 * stage reuses; delete .alchemy/local to reclaim the space.
 */
async function removeStage(stage) {
  await rm(join(ALCHEMY, "state", "Nap", stage), { recursive: true, force: true });
}
