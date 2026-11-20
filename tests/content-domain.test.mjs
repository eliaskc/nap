import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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
const { exportJWK, generateKeyPair, SignJWT } = await import("jose");
const { resolveHost, isContentDomainHost } = await import("../src/lib/site-serving.ts");
const { napLabel, napUrl } = await import("../src/lib/nap-urls.ts");
const { redirectFromOldHost, verifyContentAccess } = await import("../src/lib/content-domain.ts");
const { respond, runNap } = await import("../src/server/runtime.ts");
const { settingsFromEnv } = await import("../src/server/platform.ts");
const { fillDeploymentText } = await import("../src/lib/deployment-text.ts");
const { renderInstructions } = await import("../src/lib/instructions-text.ts");
const topic = (name) =>
  readFileSync(new URL(`../src/content/instructions/${name}.md`, import.meta.url), "utf8");
const { contentAccess, productionSettings } = await import("../infra/production.ts");
const { napConfig } = await import("../nap.config.ts");

const ROOT = "nap.test";
const CONTENT = "napcontent.test";

test("hosts without a separate content domain: as before", () => {
  assert.deepEqual(resolveHost(ROOT, ROOT), { type: "dashboard" });
  assert.deepEqual(resolveHost(`elo.${ROOT}`, ROOT), { type: "site", slug: "elo" });
  assert.deepEqual(resolveHost(`ELO.${ROOT}:443`, ROOT, ROOT), { type: "site", slug: "elo" });
  assert.deepEqual(resolveHost(`artifacts.${ROOT}`, ROOT), { type: "artifacts" });
  assert.deepEqual(resolveHost(`a.b.${ROOT}`, ROOT), { type: "unknown" });
  assert.deepEqual(resolveHost("localhost:1337", ROOT), { type: "dashboard" });
  assert.equal(isContentDomainHost(`elo.${ROOT}`, ROOT, ROOT), false);
});

test("hosts with a separate content domain", () => {
  const host = (name) => resolveHost(name, ROOT, CONTENT);
  assert.deepEqual(host(ROOT), { type: "dashboard" });
  assert.deepEqual(host(`elo.${CONTENT}`), { type: "site", slug: "elo" });
  assert.deepEqual(host(`elo.${ROOT}`), { type: "moved", slug: "elo" });
  assert.deepEqual(host(CONTENT), { type: "contentApex" });
  assert.deepEqual(host(`www.${CONTENT}`), { type: "contentApex" });
  assert.deepEqual(host(`a.b.${CONTENT}`), { type: "unknown" });
  assert.deepEqual(host(`artifacts.${ROOT}`), { type: "artifacts" });
  assert.deepEqual(host("localhost"), { type: "dashboard" });
  // A look-alike is neither.
  assert.deepEqual(host(`elo.x${CONTENT}`), { type: "dashboard" });
  for (const name of [CONTENT, `www.${CONTENT}`, `elo.${CONTENT}`, `a.b.${CONTENT}:443`]) {
    assert.equal(isContentDomainHost(name, ROOT, CONTENT), true, name);
  }
  for (const name of [ROOT, `elo.${ROOT}`, `x${CONTENT}`, "localhost"]) {
    assert.equal(isContentDomainHost(name, ROOT, CONTENT), false, name);
  }
});

test("own-host URLs and labels use the content domain", () => {
  const site = { slug: "elo", kind: "site" };
  const framed = { slug: "abc", kind: "artifact" };
  const place = { rootDomain: ROOT, contentDomain: CONTENT };
  assert.equal(napUrl(site, place), `https://elo.${CONTENT}/`);
  assert.equal(napUrl(framed, place), `https://${ROOT}/abc`);
  assert.equal(napUrl(site, { rootDomain: ROOT }), `https://elo.${ROOT}/`);
  assert.equal(
    napUrl(site, { ...place, localOrigin: "http://localhost:1" }),
    "http://localhost:1/s/elo/",
  );
  assert.equal(napLabel(site, place), `elo.${CONTENT}`);
  assert.equal(napLabel(framed, place), `${ROOT}/abc`);
  assert.equal(napLabel(site, ROOT), `elo.${ROOT}`);
  // This instance's own labels follow its config.
  assert.equal(napLabel(site), `elo.${napConfig.contentDomain || napConfig.rootDomain}`);
});

test("settings: the content domain and its Access application", () => {
  const same = settingsFromEnv({ NAP_ROOT_DOMAIN: ROOT }, "x.test");
  assert.equal(same.contentDomain, ROOT);
  assert.equal(same.contentAccess, null);
  const separate = settingsFromEnv(
    {
      NAP_ROOT_DOMAIN: ROOT,
      NAP_CONTENT_DOMAIN: CONTENT,
      NAP_ACCESS_ISSUER: "https://team.cloudflareaccess.com/",
      NAP_CONTENT_ACCESS_AUD: "aud",
    },
    "x.test",
  );
  assert.equal(separate.contentDomain, CONTENT);
  assert.deepEqual(separate.contentAccess, {
    issuer: "https://team.cloudflareaccess.com",
    aud: "aud",
  });
  // An audience without a separate content domain means nothing.
  assert.equal(
    settingsFromEnv({ NAP_ROOT_DOMAIN: ROOT, NAP_CONTENT_ACCESS_AUD: "aud" }, "x").contentAccess,
    null,
  );
});

test("agent texts show own-host addresses on the content domain", () => {
  const config = { ...napConfig, rootDomain: ROOT, contentDomain: CONTENT };
  assert.equal(
    fillDeploymentText("<n>.{{contentDomain}} {{rootDomain}}", config),
    `<n>.${CONTENT} ${ROOT}`,
  );
  assert.equal(
    fillDeploymentText("{{contentDomain}}", { ...config, contentDomain: undefined }),
    ROOT,
  );
  for (const name of ["index", "sites", "api"]) {
    const text = renderInstructions(topic(name), config, ROOT);
    assert.ok(text.includes(`<name>.${CONTENT}`) || text.includes(`<id>.${CONTENT}`), name);
    assert.ok(!text.includes(`<name>.${ROOT}`) && !text.includes(`<id>.${ROOT}`), name);
    assert.doesNotMatch(text, /\{\{contentDomain\}\}/);
  }
  const plain = renderInstructions(topic("sites"), { ...config, contentDomain: undefined }, ROOT);
  assert.ok(plain.includes(`<name>.${ROOT}`));
});

// Production settings for an instance with a separate content domain.
const production = () => ({
  accountId: "a".repeat(32),
  zoneId: "z".repeat(32),
  zoneName: "nap.test",
  accessIssuer: "https://team.cloudflareaccess.com",
  databaseId: "",
  dns: [ROOT, `*.${ROOT}`].map((name) => ({
    name,
    type: "AAAA",
    content: "100::",
    proxied: true,
    ttl: 1,
  })),
  people: ["you@example.com"],
  humanAccess: {
    type: "self_hosted",
    name: "nap",
    domain: `${ROOT}/*`,
    destinations: [
      { type: "public", uri: `${ROOT}/*` },
      { type: "public", uri: `*.${ROOT}/*` },
    ],
    sessionDuration: "168h",
    appLauncherVisible: true,
    allowedIdps: ["idp"],
    autoRedirectToIdentity: false,
  },
  content: {
    zoneId: "c".repeat(32),
    zoneName: CONTENT,
    dns: [CONTENT, `*.${CONTENT}`].map((name) => ({
      name,
      type: "AAAA",
      content: "100::",
      proxied: true,
      ttl: 1,
    })),
  },
});

test("production settings describe a separate content domain's zone", () => {
  const check = (config, content = CONTENT) => productionSettings(config, ROOT, content);
  const config = production();
  assert.equal(check(config), config);
  const invalid = /Invalid production settings/;
  assert.throws(() => check({ ...production(), content: undefined }), invalid, "needs its zone");
  assert.throws(() => check(production(), ROOT), invalid, "no content zone without the setting");
  const unproxied = production();
  unproxied.content.dns[1].proxied = false;
  assert.throws(() => check(unproxied), invalid, "proxied records");
  const noApex = production();
  noApex.content.dns = noApex.content.dns.slice(1);
  assert.throws(() => check(noApex), invalid, "the apex too");
  assert.throws(
    () => check({ ...production(), content: { ...production().content, zoneName: "other.test" } }),
    invalid,
  );
  // Not inside the root's zone: that would share the root's cookies again.
  const inRootZone = production();
  inRootZone.content = { ...inRootZone.content, zoneName: "nap.test" };
  inRootZone.content.dns = ["u.nap.test", "*.u.nap.test"].map((name) => ({
    ...production().content.dns[0],
    name,
  }));
  assert.throws(() => check(inRootZone, "u.nap.test"), invalid);
  // The human application must not cover the content domain itself.
  const covered = production();
  covered.humanAccess.destinations.push({ type: "public", uri: `*.${CONTENT}/*` });
  assert.throws(() => check(covered), invalid);
});

test("the content domain's Access application mirrors the human one", () => {
  const app = contentAccess(production(), CONTENT);
  assert.deepEqual(app, {
    type: "self_hosted",
    name: "nap-content",
    domain: `${CONTENT}/*`,
    destinations: [
      { type: "public", uri: `${CONTENT}/*` },
      { type: "public", uri: `*.${CONTENT}/*` },
    ],
    sessionDuration: "168h",
    allowedIdps: ["idp"],
    autoRedirectToIdentity: false,
    appLauncherVisible: false,
    httpOnlyCookieAttribute: true,
    sameSiteCookieAttribute: "lax",
  });
  assert.equal(contentAccess({ ...production(), content: undefined }, CONTENT), null);
});

function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO profiles (email, display_name) VALUES ('o@x.test', 'Owner')`);
  const site = (slug, kind) =>
    sqlite.exec(`INSERT INTO sites (slug, title, created_by_email, updated_by_email, current_version,
      sort_order, kind) VALUES ('${slug}', '${slug}', 'o@x.test', 'o@x.test', 'v1', 1, '${kind}')`);
  site("elo", "site");
  site("board", "artifact");
  sqlite.exec(
    `INSERT INTO nap_redirects (slug, site_slug) VALUES ('old-elo', 'elo'), ('old-board', 'board')`,
  );
  return {
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
}

test("old <name>.<root> hosts only redirect", async () => {
  const env = { DB: database(), NAP_ROOT_DOMAIN: ROOT, NAP_CONTENT_DOMAIN: CONTENT };
  const place = { rootDomain: ROOT, contentDomain: CONTENT };
  const old = (slug, path, method = "GET") =>
    respond(
      env,
      redirectFromOldHost(slug, new Request(`https://${slug}.${ROOT}${path}`, { method }), place),
    );
  const own = await old("elo", "/games/a?x=1");
  assert.equal(own.status, 301);
  assert.equal(own.headers.get("location"), `https://elo.${CONTENT}/games/a?x=1`);
  const posted = await old("elo", "/_nap/data/scores", "POST");
  assert.equal(posted.status, 308, "method-preserving");
  assert.equal(posted.headers.get("location"), `https://elo.${CONTENT}/_nap/data/scores`);
  const framed = await old("board", "/notes/?x=1");
  assert.equal(framed.status, 302);
  assert.equal(framed.headers.get("location"), `https://${ROOT}/board/notes/?x=1`);
  assert.equal((await old("board", "/")).headers.get("location"), `https://${ROOT}/board`);
  const renamed = await old("old-elo", "/a?b");
  assert.equal(renamed.status, 302, "an old name may be taken later: not permanent");
  assert.equal(renamed.headers.get("location"), `https://elo.${CONTENT}/a?b`);
  assert.equal((await old("old-board", "/")).headers.get("location"), `https://${ROOT}/board`);
  const worker = await respond(
    env,
    redirectFromOldHost(
      "elo",
      new Request(`https://elo.${ROOT}/sw.js`, { headers: { "service-worker": "script" } }),
      place,
    ),
  );
  assert.equal(worker.status, 404, "an old service worker gets no update");
  assert.equal(worker.headers.get("clear-site-data"), '"storage"');
  const missing = await old("nobody", "/");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("location"), null);
});

/** A stand-in for the Access team's key endpoint, and tokens it signs. */
async function team() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const server = createServer((request, response) => {
    if (request.url !== "/cdn-cgi/access/certs") return response.writeHead(404).end();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const sign = ({
    email = "anna@x.test",
    aud = "content-aud",
    iss = issuer,
    key = privateKey,
  } = {}) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);
  return { issuer, sign, otherKey: other.privateKey, close: () => server.close() };
}

test("content hosts need an Access JWT for the content application", async (t) => {
  const access = await team();
  t.after(access.close);
  const env = {
    DB: database(),
    NAP_ROOT_DOMAIN: ROOT,
    NAP_CONTENT_DOMAIN: CONTENT,
    NAP_ACCESS_ISSUER: access.issuer,
    NAP_CONTENT_ACCESS_AUD: "content-aud",
  };
  const check = async (headers) => {
    const request = new Request(`https://elo.${CONTENT}/`, { headers });
    const result = await runNap(env, verifyContentAccess(request)).then(
      (checked) => ({
        ok: true,
        email: checked.headers.get("cf-access-authenticated-user-email"),
        dev: checked.headers.get("x-nap-dev-email"),
      }),
      () => ({ ok: false }),
    );
    return result;
  };
  const valid = await access.sign();
  assert.deepEqual(
    await check({
      "cf-access-jwt-assertion": valid,
      "cf-access-authenticated-user-email": "anna@x.test",
    }),
    { ok: true, email: "anna@x.test", dev: null },
  );
  // The header follows the verified token, and the local dev header never counts.
  assert.deepEqual(
    await check({
      "cf-access-jwt-assertion": valid,
      "cf-access-authenticated-user-email": "boss@x.test",
      "x-nap-dev-email": "boss@x.test",
    }),
    { ok: true, email: "anna@x.test", dev: null },
  );
  assert.deepEqual(
    await check({ "cf-access-authenticated-user-email": "anna@x.test" }),
    { ok: false },
    "no token",
  );
  assert.deepEqual(await check({ "x-nap-dev-email": "anna@x.test" }), { ok: false });
  // The root's application has another audience: its session does not open content hosts.
  assert.deepEqual(
    await check({ "cf-access-jwt-assertion": await access.sign({ aud: "root-aud" }) }),
    { ok: false },
  );
  assert.deepEqual(
    await check({
      "cf-access-jwt-assertion": await access.sign({ iss: "https://evil.cloudflareaccess.com" }),
    }),
    { ok: false },
  );
  assert.deepEqual(
    await check({ "cf-access-jwt-assertion": await access.sign({ key: access.otherKey }) }),
    { ok: false },
  );
  assert.deepEqual(await check({ "cf-access-jwt-assertion": "not-a-jwt" }), { ok: false });
  const refused = await respond(env, verifyContentAccess(new Request(`https://elo.${CONTENT}/`)));
  assert.equal(refused.status, 403);
});

test("without a configured application, content hosts still need the Access header", async () => {
  const env = { DB: database(), NAP_ROOT_DOMAIN: ROOT, NAP_CONTENT_DOMAIN: CONTENT };
  const check = (headers) =>
    runNap(env, verifyContentAccess(new Request(`https://elo.${CONTENT}/`, { headers }))).then(
      (request) => request.headers.get("cf-access-authenticated-user-email"),
      () => null,
    );
  assert.equal(await check({ "cf-access-authenticated-user-email": "anna@x.test" }), "anna@x.test");
  assert.equal(await check({ "x-nap-dev-email": "anna@x.test" }), null);
  assert.equal(await check({}), null);
});
