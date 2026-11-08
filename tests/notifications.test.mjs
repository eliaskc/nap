import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

// apps.ts reaches nap-server.ts, which imports the Workers runtime and uses the ~/ alias.
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
        url: `data:text/javascript,export const appTemplateFiles = () => [{ path: "nap.json", content: "{}", encoding: "utf8", executable: false }];`,
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

// Workers globals that Node lacks: FixedLengthStream and crypto.DigestStream.
globalThis.FixedLengthStream ??= class extends TransformStream {
  constructor(length) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== length) controller.error(new Error(`Expected ${length} bytes, got ${seen}`));
      },
    });
  }
};
crypto.DigestStream ??= class extends WritableStream {
  constructor() {
    const hash = createHash("sha256");
    let resolve;
    const digest = new Promise((r) => (resolve = r));
    super({
      write(chunk) {
        hash.update(chunk);
      },
      close() {
        resolve(new Uint8Array(hash.digest()).buffer);
      },
    });
    this.digest = digest;
  }
};

const { napConfig } = await import("../nap.config.ts");
const { sendNotification, saveWebTarget, saveApnsTarget, handleNotifyRequest } =
  await import("../src/lib/notifications.ts");
const { runNap, respond } = await import("../src/server/runtime.ts");
const { generateKeyPairSync, createECDH, createDecipheriv, hkdfSync } = await import("node:crypto");

function d1(sqlite) {
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind(...values) {
      return statement(sql, values);
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
  });
  return { prepare: (sql) => statement(sql) };
}

const PLACE = { rootDomain: "nap.example.com", localOrigin: null };
const SITE = (slug, title = "Weave") => ({
  kind: "site",
  slug,
  title,
  napKind: "site",
  place: PLACE,
});
const ME = { email: "me@x.com", name: "Me" };

/** Rejects with an HttpError whose message matches. */
const failsWith = (promise, pattern) =>
  assert.rejects(promise, (error) => pattern.test(error.body?.error ?? error.message));

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  const pem = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const env = { DB: d1(sqlite), NAP_APNS_KEY_ID: "KEY1234567", NAP_APNS_PRIVATE_KEY: pem };
  const site = (slug, visibility, owner = "me@x.com") => {
    sqlite
      .prepare("INSERT OR IGNORE INTO profiles (email, display_name) VALUES (?, ?)")
      .run(owner, owner);
    return sqlite
      .prepare(
        "INSERT INTO sites (slug, kind, title, visibility, created_by_email, updated_by_email, current_version, sort_order) VALUES (?, 'site', ?, ?, ?, ?, 'v1', 0)",
      )
      .run(slug, slug, visibility, owner, owner);
  };
  return { sqlite, env, site };
}

/** A browser subscription: its ECDH key pair and auth secret, and a decrypter like a browser's. */
function browser(endpoint) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
  return {
    subscription: { endpoint, p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) },
    decrypt(body) {
      const bytes = Buffer.from(body);
      const salt = bytes.subarray(0, 16);
      const idlen = bytes[20];
      const senderPublic = bytes.subarray(21, 21 + idlen);
      const sealed = bytes.subarray(21 + idlen);
      const shared = ecdh.computeSecret(senderPublic);
      const info = Buffer.concat([
        Buffer.from("WebPush: info\0"),
        ecdh.getPublicKey(),
        senderPublic,
      ]);
      const ikm = Buffer.from(hkdfSync("sha256", shared, auth, info, 32));
      const cek = Buffer.from(
        hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
      );
      const nonce = Buffer.from(
        hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
      );
      const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - 16)),
        decipher.final(),
      ]);
      assert.equal(plain[plain.length - 1], 2);
      return JSON.parse(plain.subarray(0, -1).toString());
    },
  };
}

/** Captures pushes instead of sending them. `answer` picks each one's status. */
function capture(answer = () => 201) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init.body instanceof Uint8Array ? init.body : String(init.body);
    sent.push({ url: String(url), headers: init.headers, body });
    return new Response(answer(String(url)) === 410 ? "" : "{}", { status: answer(String(url)) });
  };
  return { sent, restore: () => (globalThis.fetch = original) };
}

async function withConfig(change, fn) {
  const previous = { notifications: napConfig.notifications, apps: napConfig.apps };
  Object.assign(napConfig, change);
  try {
    await fn();
  } finally {
    Object.assign(napConfig, previous);
  }
}

const IOS = {
  app: "g",
  ios: { teamId: "TEAM123456", appStoreId: "1", bundleId: "com.x.app", profileName: "p" },
};

test("off unless the config turns notifications on", async () => {
  await withConfig({ notifications: undefined }, async () => {
    const { env } = setup();
    await failsWith(runNap(env, sendNotification(SITE("weave"), ME, { title: "Hi" })), /off/);
  });
});

test("a page's notification reaches everyone else who can see it, encrypted, and never the sender", async () => {
  await withConfig({ notifications: true, apps: IOS }, async () => {
    const { env, site, sqlite } = setup();
    site("weave", "selected");
    sqlite
      .prepare("INSERT INTO site_viewers (site_slug, email) VALUES ('weave', 'ann@x.com')")
      .run();
    const ann = browser("https://push.example/ann");
    const bob = browser("https://push.example/bob"); // cannot see the site
    const mine = browser("https://push.example/me");
    await runNap(env, saveWebTarget("ann@x.com", ann.subscription, "Chrome"));
    await runNap(env, saveWebTarget("bob@x.com", bob.subscription, "Chrome"));
    await runNap(env, saveWebTarget("me@x.com", mine.subscription, "Chrome"));
    await runNap(
      env,
      saveApnsTarget("ann@x.com", { token: "ab".repeat(32), environment: "production" }, "iPhone"),
    );

    const pushes = capture();
    try {
      const result = await runNap(
        env,
        sendNotification(SITE("weave"), ME, {
          title: "Elias wants to play",
          body: "Join!",
          open: "/room/1",
        }),
      );
      assert.deepEqual(result, { sent: 1 });
    } finally {
      pushes.restore();
    }
    assert.deepEqual(pushes.sent.map((p) => p.url).sort(), [
      `https://api.push.apple.com/3/device/${"ab".repeat(32)}`,
      "https://push.example/ann",
    ]);
    const web = pushes.sent.find((p) => p.url.startsWith("https://push.example"));
    assert.match(web.headers.authorization, /^vapid t=.+, k=.+$/);
    assert.equal(web.headers["content-encoding"], "aes128gcm");
    assert.deepEqual(ann.decrypt(web.body), {
      title: "Elias wants to play",
      subtitle: "Weave",
      body: "Join!",
      url: "https://weave.nap.example.com/room/1",
      source: "site:weave",
    });
    const apns = pushes.sent.find((p) => p.url.includes("apple.com"));
    assert.equal(apns.headers["apns-topic"], "com.x.app");
    assert.match(apns.headers.authorization, /^bearer /);
    const payload = JSON.parse(apns.body);
    assert.equal(payload.aps.alert.title, "Elias wants to play");
    assert.equal(payload.url, "https://weave.nap.example.com/room/1");
  });
});

test("links stay on this Nap, and dead subscriptions go away", async () => {
  await withConfig({ notifications: true, apps: null }, async () => {
    const { env, site, sqlite } = setup();
    site("weave", "everyone");
    await failsWith(
      runNap(
        env,
        sendNotification(SITE("weave"), ME, { title: "Hi", open: "https://evil.example/" }),
      ),
      /must be a page on nap\.example\.com/,
    );
    await failsWith(runNap(env, sendNotification(SITE("weave"), ME, { title: "  " })), /title/);
    const ann = browser("https://push.example/gone");
    await runNap(env, saveWebTarget("ann@x.com", ann.subscription, "Chrome"));
    // Without an APNs key and iOS, phones are skipped.
    await runNap(
      env,
      saveApnsTarget("ann@x.com", { token: "cd".repeat(32), environment: "production" }, "iPhone"),
    );
    const pushes = capture(() => 410);
    try {
      await runNap(
        env,
        sendNotification(SITE("weave"), ME, { title: "Hi", open: "https://dle.nap.example.com/" }),
      );
    } finally {
      pushes.restore();
    }
    assert.equal(pushes.sent.length, 1);
    const left = sqlite
      .prepare("SELECT kind FROM push_targets")
      .all()
      .map((r) => r.kind);
    assert.deepEqual(left, ["apns"]);
  });
});

test("a few a minute per sender", async () => {
  await withConfig({ notifications: true, apps: null }, async () => {
    const { env, site } = setup();
    site("weave", "everyone");
    for (let i = 0; i < 3; i++)
      await runNap(env, sendNotification(SITE("weave"), ME, { title: `n${i}` }));
    await failsWith(
      runNap(env, sendNotification(SITE("weave"), ME, { title: "again" })),
      /Too many/,
    );
    // Someone else can still send.
    await runNap(
      env,
      sendNotification(SITE("weave"), { email: "ann@x.com", name: "Ann" }, { title: "mine" }),
    );
  });
});

test("POST /_nap/notify: only people who can see the page, and not from other sites", async () => {
  await withConfig({ notifications: true, apps: null }, async () => {
    const { env, site } = setup();
    site("secret", "private", "owner@x.com");
    const post = (headers = {}) =>
      respond(
        env,
        handleNotifyRequest(
          "secret",
          new Request("https://secret.nap.example.com/_nap/notify", {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({ title: "Hi" }),
          }),
          ME,
          PLACE,
        ),
      );
    assert.equal((await post()).status, 403);
    assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
  });
});
