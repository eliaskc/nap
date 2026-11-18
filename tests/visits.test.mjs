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
const { recordVisit, listVisitors } = await import("../src/lib/visits.ts");
const { listSites } = await import("../src/lib/nap-server.ts");
const { runNap } = await import("../src/server/runtime.ts");

const OWNER = "owner@example.com";
const ANNA = "anna@example.com";
const BO = "bo@example.com";

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO profiles (email, display_name) VALUES ('${OWNER}', 'Olle Owner'),
      ('${ANNA}', 'Anna Andersson');
    INSERT INTO sites (slug, title, created_by_email, updated_by_email, current_version, sort_order,
      visibility)
      VALUES ('quiz', 'Quiz', '${OWNER}', '${OWNER}', 'v1', 1, 'everyone');`);
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

const visit = (env, email, type = "page") =>
  runNap(env, recordVisit(email, { slug: "quiz", type }));

test("opens within 30 minutes are one visit; later ones count again", async () => {
  const { sqlite, env } = setup();
  await visit(env, ANNA);
  await visit(env, "Anna@Example.com");
  let [anna] = await runNap(env, listVisitors("quiz", OWNER));
  assert.equal(anna.visits, 1);
  assert.equal(anna.name, "Anna Andersson");

  sqlite.exec(`UPDATE site_visits SET visited_at = '2020-01-01T00:00:00.000Z',
    first_visited_at = '2020-01-01T00:00:00.000Z'`);
  await visit(env, ANNA);
  [anna] = await runNap(env, listVisitors("quiz", OWNER));
  assert.equal(anna.visits, 2);
  assert.equal(anna.firstVisitedAt, "2020-01-01T00:00:00.000Z");
  assert.notEqual(anna.visitedAt, anna.firstVisitedAt);
});

test("the owner is left out of the visitors and the count", async () => {
  const { env } = setup();
  await visit(env, OWNER);
  await visit(env, ANNA);
  await visit(env, BO);
  const visitors = await runNap(env, listVisitors("quiz", OWNER));
  assert.deepEqual(visitors.map((v) => v.email).sort(), [ANNA, BO]);
  assert.equal(visitors.find((v) => v.email === BO).name, "Bo");

  const [site] = await runNap(env, listSites({ email: ANNA, name: "Anna" }));
  assert.equal(site.visitorCount, 2);
});

test("a dashboard counts each person once, but still remembers when they opened it", async () => {
  const { sqlite, env } = setup();
  const OLD = "2020-01-01T00:00:00.000Z";
  const age = () => sqlite.exec(`UPDATE site_visits SET visited_at = '${OLD}'`);
  await visit(env, ANNA, "dashboard");
  age();
  await visit(env, ANNA, "dashboard");
  let [anna] = await runNap(env, listVisitors("quiz", OWNER));
  assert.equal(anna.visits, 1);
  assert.notEqual(anna.visitedAt, OLD);
  const [site] = await runNap(env, listSites({ email: ANNA, name: "Anna" }));
  assert.equal(site.visitorCount, 1);
  assert.ok(site.visitedAt, "it shows as visited");

  // Counts already stored stay when the type changes.
  age();
  await visit(env, ANNA, "page");
  age();
  await visit(env, ANNA, "dashboard");
  [anna] = await runNap(env, listVisitors("quiz", OWNER));
  assert.equal(anna.visits, 2);
});
