import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export const env = {}; export class DurableObject {}",
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
const { findPerson, listPeople, saveProfile } = await import("../src/lib/profiles.ts");
const { runNap } = await import("../src/server/runtime.ts");

const ANNA = "anna@example.com";
const BO = "bo@example.com";

function environment() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec(
    `INSERT INTO profiles (email, display_name) VALUES ('${ANNA}', 'Anna'), ('${BO}', NULL);`,
  );
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
  return { sqlite, env: { DB } };
}

async function withAvatars(on, body) {
  const before = napConfig.avatars;
  napConfig.avatars = on;
  try {
    await body();
  } finally {
    napConfig.avatars = before;
  }
}

const looks = (sqlite) =>
  sqlite.prepare("SELECT email, shape, color FROM profiles ORDER BY email").all();

test("without avatars, nobody gets a look and saving keeps it that way", () =>
  withAvatars(false, async () => {
    const { sqlite, env } = environment();
    const people = await runNap(env, listPeople());
    assert.deepEqual(
      people.map(({ shape, color }) => ({ shape, color })),
      [
        { shape: null, color: null },
        { shape: null, color: null },
      ],
    );
    const me = await runNap(env, findPerson(BO));
    assert.equal(me.shape, null);
    const saved = await runNap(
      env,
      saveProfile({ email: BO, name: null }, { name: "Bo", shape: "pill", color: "red" }),
    );
    assert.deepEqual(
      { name: saved.name, shape: saved.shape, color: saved.color },
      {
        name: "Bo",
        shape: null,
        color: null,
      },
    );
    for (const row of looks(sqlite)) assert.equal(row.shape, null);
  }));

test("with avatars, everyone gets a look", () =>
  withAvatars(true, async () => {
    const { sqlite, env } = environment();
    const people = await runNap(env, listPeople());
    for (const person of people) assert.ok(person.shape && person.color);
    for (const row of looks(sqlite)) assert.ok(row.shape && row.color);
  }));
