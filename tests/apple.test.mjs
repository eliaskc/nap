import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
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
const { extensionProfile } = await import("../src/lib/apple.ts");
const { runNap } = await import("../src/server/runtime.ts");

function bucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, options) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, options });
      return { key, size: bytes.byteLength };
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        customMetadata: object.options?.customMetadata,
        arrayBuffer: async () => object.bytes.buffer,
      };
    },
  };
}

function env() {
  const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  return {
    DB: {},
    SITES: bucket(),
    NAP_ASC_KEY_ID: "KEY",
    NAP_ASC_ISSUER_ID: "issuer",
    NAP_ASC_PRIVATE_KEY: privateKey,
  };
}

/** App Store Connect as a map of "METHOD path" to answers, recording every call. */
function apple(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace("https://api.appstoreconnect.apple.com/v1/", "");
    const call = { method: init.method ?? "GET", path, body: init.body && JSON.parse(init.body) };
    calls.push(call);
    const route = Object.entries(routes).find(([key]) => `${call.method} ${path}`.startsWith(key));
    if (!route) return Response.json({ errors: [{ detail: "unexpected" }] }, { status: 500 });
    const [status, body] = route[1](call);
    return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

async function withIos(fn) {
  const previous = napConfig.apps;
  napConfig.apps = {
    app: "g",
    ios: { teamId: "TEAM", appStoreId: "1", bundleId: "com.x.app", profileName: "GG App Store" },
  };
  try {
    await fn();
  } finally {
    napConfig.apps = previous;
  }
}

const content = (text) => Buffer.from(text).toString("base64");

test("an extension's App ID and profile are made when missing, with the app's certificates", async () => {
  await withIos(async () => {
    const e = env();
    const asc = apple({
      "GET profiles?filter[name]=GG%20App%20Store%20notifications": () => [200, { data: [] }],
      "GET bundleIds?filter[identifier]=com.x.app.notifications": () => [
        200,
        { data: [{ id: "other", attributes: { identifier: "com.x.app.notifications.old" } }] },
      ],
      "POST bundleIds": () => [201, { data: { id: "B2" } }],
      "GET profiles?filter[name]=GG%20App%20Store": () => [
        200,
        {
          data: [
            {
              id: "P1",
              attributes: { name: "GG App Store", profileState: "ACTIVE", profileContent: "" },
            },
          ],
        },
      ],
      "GET profiles/P1/certificates": () => [200, { data: [{ id: "C1" }] }],
      "POST profiles": () => [
        201,
        {
          data: {
            id: "P2",
            attributes: { name: "x", profileState: "ACTIVE", profileContent: content("ext") },
          },
        },
      ],
    });
    let profile;
    try {
      profile = await runNap(e, extensionProfile("com.x.app.notifications"));
    } finally {
      asc.restore();
    }
    assert.equal(profile.id, "P2");
    assert.equal(Buffer.from(profile.bytes).toString(), "ext");
    const bundle = asc.calls.find((c) => c.method === "POST" && c.path === "bundleIds").body.data;
    assert.deepEqual(bundle.attributes, {
      identifier: "com.x.app.notifications",
      name: "Nap com x app notifications",
      platform: "IOS",
    });
    const made = asc.calls.find((c) => c.method === "POST" && c.path === "profiles").body.data;
    assert.equal(made.attributes.name, "GG App Store notifications");
    assert.equal(made.attributes.profileType, "IOS_APP_STORE");
    assert.deepEqual(made.relationships.bundleId.data, { type: "bundleIds", id: "B2" });
    assert.deepEqual(made.relationships.certificates.data, [{ type: "certificates", id: "C1" }]);
    assert.ok(e.SITES.objects.has("apps/_signing/com.x.app.notifications.mobileprovision"));
  });
});

test("an active extension profile is used as it is, and the copy in R2 when Apple is down", async () => {
  await withIos(async () => {
    const e = env();
    const active = apple({
      "GET profiles?filter[name]=GG%20App%20Store%20notifications": () => [
        200,
        {
          data: [
            {
              id: "P3",
              attributes: {
                name: "GG App Store notifications",
                profileState: "ACTIVE",
                profileContent: content("kept"),
              },
            },
          ],
        },
      ],
    });
    try {
      assert.equal((await runNap(e, extensionProfile("com.x.app.notifications"))).id, "P3");
    } finally {
      active.restore();
    }
    assert.equal(active.calls.length, 1);
    const down = apple({});
    try {
      const copy = await runNap(e, extensionProfile("com.x.app.notifications"));
      assert.equal(copy.id, "P3");
      assert.equal(Buffer.from(copy.bytes).toString(), "kept");
      // Never made, and Apple is down: none, so the build signs without the extension.
      assert.equal(await runNap(e, extensionProfile("com.x.app.other")), null);
    } finally {
      down.restore();
    }
  });
});
