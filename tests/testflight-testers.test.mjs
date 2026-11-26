import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

// The templates are bundled by Vite (import.meta.glob), which Node does not have.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export const env = {}; export class DurableObject {}",
        shortCircuit: true,
      };
    }
    if (specifier === "~/lib/app-template") {
      return {
        url: "data:text/javascript,export const appTemplateFiles = () => [];",
        shortCircuit: true,
      };
    }
    if (specifier === "~/nap.config") {
      return next(new URL("../nap.config.ts", import.meta.url).href, context);
    }
    if (specifier.startsWith("~/")) {
      return next(new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});
const { napConfig } = await import("../nap.config.ts");
const { installStatus, requestInvite } = await import("../src/lib/testflight-testers.ts");
const { runNap } = await import("../src/server/runtime.ts");

const NAP = "elias@work.example";
const APPLE = "elias@icloud.example";
const ME = { email: NAP, name: "Elias Carlson" };

function env() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  const DB = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async first() {
          return sqlite.prepare(sql).get(...args) ?? null;
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...args) };
        },
        async run() {
          const result = sqlite.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  return {
    sqlite,
    env: {
      DB,
      SITES: {},
      NAP_ASC_KEY_ID: "KEY",
      NAP_ASC_ISSUER_ID: "issuer",
      NAP_ASC_PRIVATE_KEY: privateKey,
    },
  };
}

/**
 * App Store Connect where the Nap sign-in is a user and a tester already (as at a company whose
 * people all are), and the personal address is neither until Nap invites it.
 */
function apple() {
  const invited = new Set();
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = decodeURIComponent(
      String(url).replace("https://api.appstoreconnect.apple.com/v1/", ""),
    );
    const method = init.method ?? "GET";
    calls.push(`${method} ${path.split("?")[0]}`);
    const email = /filter\[(?:username|email)\]=([^&]+)/.exec(path)?.[1];
    if (method === "GET" && path.startsWith("users?")) {
      return Response.json({
        data:
          email === NAP ? [{ id: "U1", attributes: { username: NAP, allAppsVisible: true } }] : [],
      });
    }
    if (method === "GET" && path.startsWith("userInvitations?")) {
      return Response.json({ data: invited.has(email) ? [{ attributes: { email } }] : [] });
    }
    if (method === "POST" && path === "userInvitations") {
      invited.add(JSON.parse(init.body).data.attributes.email);
      return Response.json({ data: {} }, { status: 201 });
    }
    if (method === "GET" && path.startsWith("betaTesters?")) {
      return Response.json({
        data: email === NAP ? [{ id: "T1", attributes: { email: NAP, state: "INSTALLED" } }] : [],
      });
    }
    return Response.json({ errors: [{ detail: `unexpected ${method} ${path}` }] }, { status: 500 });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function withIos(fn) {
  const previous = napConfig.apps;
  napConfig.apps = {
    app: "g",
    ios: { teamId: "TEAM", appStoreId: "1", bundleId: "com.x.app", profileName: "GG" },
  };
  const asc = apple();
  try {
    await fn(asc);
  } finally {
    asc.restore();
    napConfig.apps = previous;
  }
}

test("a Nap sign-in that is a tester already is found, and says it is the Nap one", async () => {
  await withIos(async () => {
    const { env: e } = env();
    const status = await runNap(e, installStatus(ME));
    assert.equal(status.appleEmail, NAP);
    assert.equal(status.sameAsNap, true);
    assert.deepEqual(status.step, { kind: "tester", tester: "installed" });
  });
});

test("another Apple Account replaces the found one and stays, instead of bouncing back", async () => {
  await withIos(async (asc) => {
    const { env: e, sqlite } = env();
    await runNap(e, installStatus(ME));
    const sent = await runNap(e, requestInvite(ME, ` ${APPLE.toUpperCase()} `));
    assert.equal(sent.appleEmail, APPLE);
    assert.equal(sent.sameAsNap, false);
    assert.deepEqual(sent.step, { kind: "team_invited", pending: true });
    assert.ok(asc.calls.includes("POST userInvitations"));

    // Looking again keeps the new address, though the Nap sign-in is still a tester.
    const again = await runNap(e, installStatus(ME));
    assert.equal(again.appleEmail, APPLE);
    assert.deepEqual(again.step, { kind: "team_invited", pending: true });
    const rows = sqlite.prepare("SELECT apple_email, state FROM testflight_testers").all();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [{ apple_email: APPLE, state: "team_invited" }],
    );
  });
});

test("going back to the Nap sign-in makes it the tester again in one step", async () => {
  await withIos(async () => {
    const { env: e } = env();
    await runNap(e, requestInvite(ME, APPLE));
    const back = await runNap(e, requestInvite(ME, NAP));
    assert.equal(back.appleEmail, NAP);
    assert.equal(back.sameAsNap, true);
    assert.equal(back.step.kind, "tester");
  });
});
