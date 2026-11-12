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
const { sendNotification, saveWebTarget, saveApnsTarget, saveFcmTarget, handleNotifyRequest } =
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

test("skip leaves people out, whatever the case of their email", async () => {
  await withConfig({ notifications: true }, async () => {
    const { env, site, sqlite } = setup();
    site("weave", "selected");
    for (const email of ["ann@x.com", "bob@x.com"]) {
      sqlite.prepare("INSERT INTO site_viewers (site_slug, email) VALUES ('weave', ?)").run(email);
    }
    const ann = browser("https://push.example/ann");
    const bob = browser("https://push.example/bob");
    await runNap(env, saveWebTarget("ann@x.com", ann.subscription, "Chrome"));
    await runNap(env, saveWebTarget("bob@x.com", bob.subscription, "Chrome"));
    const pushes = capture();
    try {
      const result = await runNap(
        env,
        sendNotification(SITE("weave"), ME, { title: "We solved it", skip: ["Ann@X.com", 7] }),
      );
      assert.deepEqual(result, { sent: 1 });
    } finally {
      pushes.restore();
    }
    assert.deepEqual(
      pushes.sent.map((p) => p.url),
      ["https://push.example/bob"],
    );
  });
});

test("only sends to the people named, and tag and quiet replace without a sound everywhere", async () => {
  const firebase = {
    projectId: "gg-play",
    senderId: "123",
    appId: "1:123:android:ab",
    apiKey: "k",
  };
  await withConfig(
    {
      notifications: true,
      apps: { ...IOS, android: { packageName: "com.x.app", testersUrl: null, firebase } },
    },
    async () => {
      const { env, site } = setup();
      site("dle", "everyone");
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      env.NAP_PLAY_SERVICE_ACCOUNT = JSON.stringify({
        client_email: "nap@gg-play.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      });
      const ann = browser("https://push.example/ann");
      const bob = browser("https://push.example/bob");
      await runNap(env, saveWebTarget("ann@x.com", ann.subscription, "Chrome"));
      await runNap(env, saveWebTarget("bob@x.com", bob.subscription, "Chrome"));
      await runNap(
        env,
        saveApnsTarget(
          "ann@x.com",
          { token: "ab".repeat(32), environment: "production" },
          "iPhone",
        ),
      );
      await runNap(env, saveFcmTarget("ann@x.com", "fcm-token-ann-0123456789", "Pixel"));
      const pushes = capture((url) => (url.startsWith("https://oauth2") ? 200 : 201));
      const original = globalThis.fetch;
      const wrapped = globalThis.fetch;
      globalThis.fetch = async (url, init) =>
        String(url).startsWith("https://oauth2.googleapis.com/")
          ? Response.json({ access_token: "ya29.fcm", expires_in: 3600 })
          : wrapped(url, init);
      try {
        const result = await runNap(
          env,
          sendNotification(SITE("dle", "Dle"), ME, {
            title: "Wordle today",
            only: ["ANN@x.com"],
            tag: "wordle:2026-11-10",
            quiet: true,
          }),
        );
        assert.deepEqual(result, { sent: 1 });
        assert.deepEqual(
          await runNap(env, sendNotification(SITE("dle", "Dle"), ME, { title: "Hi", only: [] })),
          { sent: 0 },
        );
      } finally {
        globalThis.fetch = original;
        pushes.restore();
      }
      const urls = pushes.sent.map((p) => p.url);
      assert.ok(!urls.includes("https://push.example/bob"));
      const web = pushes.sent.find((p) => p.url === "https://push.example/ann");
      const message = ann.decrypt(web.body);
      assert.equal(message.tag, "site:dle:wordle:2026-11-10");
      assert.equal(message.quiet, true);
      const apns = pushes.sent.find((p) => p.url.includes("apple.com"));
      assert.equal(apns.headers["apns-collapse-id"], "site:dle:wordle:2026-11-10");
      const aps = JSON.parse(apns.body).aps;
      assert.equal(aps["interruption-level"], "passive");
      assert.equal(aps.sound, undefined);
      const fcm = JSON.parse(pushes.sent.find((p) => p.url.includes("fcm.googleapis")).body);
      assert.equal(fcm.message.android.notification.channel_id, "nap-quiet");
      assert.equal(fcm.message.android.notification.tag, "site:dle:wordle:2026-11-10");
      assert.equal(fcm.message.android.collapse_key, "site:dle:wordle:2026-11-10");
      assert.equal(fcm.message.data.quiet, "1");
    },
  );
});

test("Android phones get them through Firebase, as the service account, and uninstalled ones go away", async () => {
  const firebase = {
    projectId: "gg-play",
    senderId: "123",
    appId: "1:123:android:ab",
    apiKey: "k",
  };
  const android = { app: "g", android: { packageName: "com.x.app", testersUrl: null, firebase } };
  await withConfig({ notifications: true, apps: android }, async () => {
    const { env, site, sqlite } = setup();
    site("weave", "everyone");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    env.NAP_PLAY_SERVICE_ACCOUNT = JSON.stringify({
      client_email: "nap@gg-play.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    });
    await runNap(env, saveFcmTarget("ann@x.com", "fcm-token-ann-0123456789", "Pixel"));
    await runNap(env, saveFcmTarget("bob@x.com", "fcm-token-bob-0123456789", "Pixel"));
    const sent = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://oauth2.googleapis.com/")) {
        const form = new URLSearchParams(String(init.body));
        const claims = JSON.parse(
          Buffer.from(form.get("assertion").split(".")[1], "base64url").toString(),
        );
        assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
        return Response.json({ access_token: "ya29.fcm", expires_in: 3600 });
      }
      const body = JSON.parse(String(init.body));
      sent.push({ url: String(url), headers: init.headers, body });
      return body.message.token.includes("bob")
        ? Response.json(
            { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } },
            { status: 404 },
          )
        : Response.json({ name: "projects/gg-play/messages/1" });
    };
    try {
      const result = await runNap(
        env,
        sendNotification(SITE("weave"), ME, { title: "Elias wants to play", body: "Join!" }),
      );
      assert.deepEqual(result, { sent: 2 });
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(sent.length, 2);
    const ann = sent.find((p) => p.body.message.token.includes("ann"));
    assert.equal(ann.url, "https://fcm.googleapis.com/v1/projects/gg-play/messages:send");
    assert.equal(ann.headers.authorization, "Bearer ya29.fcm");
    assert.deepEqual(ann.body.message.notification, {
      title: "Elias wants to play · Weave",
      body: "Join!",
    });
    assert.deepEqual(ann.body.message.data, {
      url: "https://weave.nap.example.com/",
      source: "site:weave",
      title: "Elias wants to play",
      subtitle: "Weave",
      body: "Join!",
    });
    assert.equal(ann.body.message.android.notification.channel_id, "nap");
    const left = sqlite
      .prepare("SELECT email FROM push_targets")
      .all()
      .map((r) => r.email);
    assert.deepEqual(left, ["ann@x.com"]);
  });
  // Without Firebase in the config, Android phones are skipped.
  await withConfig({ notifications: true, apps: null }, async () => {
    const { env, site } = setup();
    site("weave", "everyone");
    await runNap(env, saveFcmTarget("ann@x.com", "fcm-token-ann-0123456789", "Pixel"));
    const pushes = capture();
    try {
      assert.deepEqual(await runNap(env, sendNotification(SITE("weave"), ME, { title: "Hi" })), {
        sent: 0,
      });
    } finally {
      pushes.restore();
    }
    assert.equal(pushes.sent.length, 0);
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
    for (let i = 0; i < 5; i++)
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

test("an image file of the page goes to every device as a presigned URL", async () => {
  const firebase = {
    projectId: "gg-play",
    senderId: "123",
    appId: "1:123:android:ab",
    apiKey: "k",
  };
  await withConfig(
    {
      notifications: true,
      apps: { ...IOS, android: { packageName: "com.x.app", testersUrl: null, firebase } },
    },
    async () => {
      const { env, site } = setup();
      site("quiz", "everyone");
      const id = "a".repeat(24);
      const objects = {
        [`files/quiz/${id}`]: "image/jpeg",
        [`files/quiz/${"t".repeat(24)}`]: "text/plain",
      };
      env.SITES = {
        async head(key) {
          return objects[key] ? { size: 3, httpMetadata: { contentType: objects[key] } } : null;
        },
      };
      Object.assign(env, {
        NAP_R2_ACCOUNT_ID: "acct",
        NAP_R2_BUCKET: "nap-sites",
        NAP_R2_ACCESS_KEY_ID: "key",
        NAP_R2_SECRET_ACCESS_KEY: "secret",
      });
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      env.NAP_PLAY_SERVICE_ACCOUNT = JSON.stringify({
        client_email: "nap@gg-play.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      });
      const ann = browser("https://push.example/ann");
      await runNap(env, saveWebTarget("ann@x.com", ann.subscription, "Chrome"));
      await runNap(
        env,
        saveApnsTarget(
          "ann@x.com",
          { token: "ab".repeat(32), environment: "production" },
          "iPhone",
        ),
      );
      await runNap(env, saveFcmTarget("ann@x.com", "fcm-token-ann-0123456789", "Pixel"));
      const pushes = capture();
      const wrapped = globalThis.fetch;
      globalThis.fetch = async (url, init) =>
        String(url).startsWith("https://oauth2.googleapis.com/")
          ? Response.json({ access_token: "ya29.fcm", expires_in: 3600 })
          : wrapped(url, init);
      try {
        await failsWith(
          runNap(env, sendNotification(SITE("quiz"), ME, { title: "Hi", image: "t".repeat(24) })),
          /image file of this site/,
        );
        await failsWith(
          runNap(
            env,
            sendNotification({ kind: "app", app: null, place: PLACE }, ME, {
              title: "Hi",
              image: id,
            }),
          ),
          /file of a site/,
        );
        assert.equal(pushes.sent.length, 0);
        await runNap(env, sendNotification(SITE("quiz"), ME, { title: "Quiz night", image: id }));
      } finally {
        globalThis.fetch = wrapped;
        pushes.restore();
      }
      const web = ann.decrypt(pushes.sent.find((p) => p.url === "https://push.example/ann").body);
      const image = new URL(web.image);
      assert.equal(
        image.origin + image.pathname,
        `https://acct.r2.cloudflarestorage.com/nap-sites/files/quiz/${id}`,
      );
      assert.equal(image.searchParams.get("X-Amz-Expires"), "604800");
      const apns = JSON.parse(pushes.sent.find((p) => p.url.includes("apple.com")).body);
      assert.equal(apns.aps["mutable-content"], 1);
      assert.equal(apns.image, web.image);
      const fcm = JSON.parse(pushes.sent.find((p) => p.url.includes("fcm.googleapis")).body);
      assert.equal(fcm.message.notification.image, web.image);
      assert.equal(fcm.message.data.image, web.image);
    },
  );
});

test("without an image, APNs gets no mutable-content", async () => {
  await withConfig({ notifications: true, apps: IOS }, async () => {
    const { env, site } = setup();
    site("quiz", "everyone");
    await runNap(
      env,
      saveApnsTarget("ann@x.com", { token: "ab".repeat(32), environment: "production" }, "iPhone"),
    );
    const pushes = capture();
    try {
      await runNap(env, sendNotification(SITE("quiz"), ME, { title: "Hi" }));
    } finally {
      pushes.restore();
    }
    const apns = JSON.parse(pushes.sent[0].body);
    assert.equal(apns.aps["mutable-content"], undefined);
    assert.equal(apns.image, undefined);
  });
});
