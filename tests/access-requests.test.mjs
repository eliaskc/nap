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
const { Effect } = await import("effect");
const {
  decideAccessRequest,
  handleVisitorAccessRequest,
  useAccessRequestChannels,
  visitorRequestState,
} = await import("../src/lib/access-requests.ts");
const { handleSlackHook, verifySlackSignature } = await import("../src/lib/access-slack.ts");
const { respond, runNap } = await import("../src/server/runtime.ts");
const { napConfig } = await import("../nap.config.ts");

const OWNER = "owner@example.com";
const ANNA = "anna@example.com";
const BO = "bo@example.com";
const PLACE = { rootDomain: "nap.test", localOrigin: null };

function setup(visibility = "private") {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO profiles (email, display_name) VALUES ('${OWNER}', 'Olle Owner'),
      ('${ANNA}', 'Anna Andersson'), ('${BO}', NULL);
    INSERT INTO sites (slug, title, created_by_email, updated_by_email, current_version, sort_order,
      visibility)
      VALUES ('quiz', 'Quiz', '${OWNER}', '${OWNER}', 'v1', 1, '${visibility}');`);
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

/** A channel that remembers what it was told. `reach: false` cannot reach the owner. */
function fakeChannel({ reach = true } = {}) {
  const sent = [];
  const answeredLog = [];
  return {
    name: "fake",
    label: "Fake",
    sent,
    answeredLog,
    send: (request) =>
      Effect.sync(() => {
        sent.push(request);
        return reach ? { message: request.id } : null;
      }),
    answered: (request, ref) => Effect.sync(() => void answeredLog.push({ request, ref })),
  };
}

/** A form post or status check from the no-access page, as `email`. */
function visit(env, email, action, { headers = {}, back = "/play?x=1" } = {}) {
  const request = new Request(`https://quiz.nap.test/_nap/access/${action}`, {
    method: action === "request" ? "POST" : "GET",
    headers: {
      "cf-access-authenticated-user-email": email,
      ...(action === "request"
        ? { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }
        : {}),
      ...headers,
    },
    body: action === "request" ? new URLSearchParams({ back }).toString() : undefined,
  });
  return respond(
    env,
    handleVisitorAccessRequest("quiz", action, request, { email, name: email }, PLACE),
  );
}

const status = async (env, email) => (await (await visit(env, email, "status")).json()).state;
const requests = (sqlite) =>
  sqlite.prepare("SELECT id, email, status, decision, channel_refs FROM access_requests").all();

test.afterEach(() => useAccessRequestChannels(null));

test("without channels, requests are off and the page only says to ask", async () => {
  const { env } = setup();
  useAccessRequestChannels([]);
  assert.deepEqual(await runNap(env, visitorRequestState("quiz", ANNA)), { state: "off" });
  assert.equal((await visit(env, ANNA, "request")).status, 404);
});

test("asking tells the owner once, and the page goes back to where it was", async () => {
  const { sqlite, env } = setup();
  const channel = fakeChannel();
  useAccessRequestChannels([channel]);
  assert.equal(await status(env, ANNA), "none");

  const asked = await visit(env, ANNA, "request");
  assert.equal(asked.status, 303);
  assert.equal(asked.headers.get("location"), "/play?x=1");
  assert.equal(channel.sent.length, 1);
  const [sent] = channel.sent;
  assert.equal(sent.title, "Quiz");
  assert.equal(sent.requesterName, "Anna Andersson");
  assert.equal(sent.ownerEmail, OWNER);
  assert.equal(sent.napUrl, "https://quiz.nap.test/");
  assert.equal(sent.answerUrl, `https://nap.test/requests/${sent.id}`);
  assert.equal(await status(env, ANNA), "pending");
  assert.deepEqual(await runNap(env, visitorRequestState("quiz", ANNA)), {
    state: "pending",
    notified: true,
    channel: "Fake",
  });

  // Asking again while it is pending changes nothing.
  await visit(env, ANNA, "request");
  assert.equal(channel.sent.length, 1);
  assert.equal(requests(sqlite).length, 1);
});

test("only the same origin may ask, and `back` stays on this host", async () => {
  const { sqlite, env } = setup();
  useAccessRequestChannels([fakeChannel()]);
  const sibling = await visit(env, ANNA, "request", { headers: { "sec-fetch-site": "same-site" } });
  assert.equal(sibling.status, 403);
  assert.equal(requests(sqlite).length, 0);
  const away = await visit(env, ANNA, "request", { back: "//evil.example/" });
  assert.equal(away.headers.get("location"), "/");
});

test("a channel that cannot reach the owner leaves the request unnotified", async () => {
  const { env } = setup();
  useAccessRequestChannels([fakeChannel({ reach: false })]);
  await visit(env, ANNA, "request");
  assert.deepEqual(await runNap(env, visitorRequestState("quiz", ANNA)), {
    state: "pending",
    notified: false,
    channel: "Fake",
  });
});

test("only the owner answers; adding invites them to a private nap", async () => {
  const { sqlite, env } = setup("private");
  const channel = fakeChannel();
  useAccessRequestChannels([channel]);
  // A leftover invite from before the nap was made private must not come back.
  sqlite.exec(`INSERT INTO site_viewers (site_slug, email) VALUES ('quiz', '${BO}')`);
  await visit(env, ANNA, "request");
  const [{ id }] = requests(sqlite);

  const stranger = await respond(
    env,
    decideAccessRequest(ANNA, id, "add", PLACE).pipe(Effect.as(new Response("ok"))),
  );
  assert.equal(stranger.status, 403);

  const result = await runNap(env, decideAccessRequest(OWNER.toUpperCase(), id, "add", PLACE));
  assert.equal(result.changed, true);
  assert.equal(result.request.status, "approved");
  assert.equal(result.request.decision, "add");
  assert.equal(
    sqlite.prepare("SELECT visibility FROM sites WHERE slug = 'quiz'").get().visibility,
    "selected",
  );
  assert.deepEqual(
    sqlite
      .prepare("SELECT email FROM site_viewers ORDER BY email")
      .all()
      .map((r) => r.email),
    [ANNA],
  );
  assert.equal(await status(env, ANNA), "allowed");
  assert.equal(await status(env, BO), "none");
  // The owner's message is updated with the answer.
  assert.equal(channel.answeredLog.length, 1);
  assert.equal(channel.answeredLog[0].request.decision, "add");
  assert.deepEqual(channel.answeredLog[0].ref, { message: id });

  // Answering again changes nothing.
  const again = await runNap(env, decideAccessRequest(OWNER, id, "deny", PLACE));
  assert.equal(again.changed, false);
  assert.equal(again.request.status, "approved");
});

test("adding to a nap shared with a few keeps the others", async () => {
  const { sqlite, env } = setup("selected");
  useAccessRequestChannels([fakeChannel()]);
  sqlite.exec(`INSERT INTO site_viewers (site_slug, email) VALUES ('quiz', '${BO}')`);
  await visit(env, ANNA, "request");
  const [{ id }] = requests(sqlite);
  await runNap(env, decideAccessRequest(OWNER, id, "add", PLACE));
  assert.deepEqual(
    sqlite
      .prepare("SELECT email FROM site_viewers ORDER BY email")
      .all()
      .map((r) => r.email),
    [ANNA, BO],
  );
});

test("sharing with everyone answers every pending request", async () => {
  const { sqlite, env } = setup("private");
  const channel = fakeChannel();
  useAccessRequestChannels([channel]);
  await visit(env, ANNA, "request");
  await visit(env, BO, "request");
  const [first] = requests(sqlite);
  await runNap(env, decideAccessRequest(OWNER, first.id, "everyone", PLACE));
  assert.equal(
    sqlite.prepare("SELECT visibility FROM sites WHERE slug = 'quiz'").get().visibility,
    "everyone",
  );
  assert.deepEqual(
    requests(sqlite).map((r) => [r.status, r.decision]),
    [
      ["approved", "everyone"],
      ["approved", "everyone"],
    ],
  );
  assert.equal(channel.answeredLog.length, 2);
  assert.equal(await status(env, BO), "allowed");
});

test("a denied person can ask again the next day", async () => {
  const { sqlite, env } = setup();
  useAccessRequestChannels([fakeChannel()]);
  await visit(env, ANNA, "request");
  const [{ id }] = requests(sqlite);
  await runNap(env, decideAccessRequest(OWNER, id, "deny", PLACE));
  assert.deepEqual(await runNap(env, visitorRequestState("quiz", ANNA)), {
    state: "denied",
    canRequest: false,
    channel: "Fake",
  });
  // Too soon: the page comes back and still says so.
  const soon = await visit(env, ANNA, "request");
  assert.equal(soon.status, 303);
  assert.equal(requests(sqlite).length, 1);

  sqlite.exec("UPDATE access_requests SET created_at = '2020-01-01T00:00:00.000Z'");
  assert.equal((await runNap(env, visitorRequestState("quiz", ANNA))).canRequest, true);
  await visit(env, ANNA, "request");
  assert.equal(requests(sqlite).length, 2);
  assert.equal(await status(env, ANNA), "pending");
});

test("deleting the nap takes its requests along", async () => {
  const { sqlite, env } = setup();
  useAccessRequestChannels([fakeChannel()]);
  await visit(env, ANNA, "request");
  sqlite.exec("PRAGMA foreign_keys = ON; DELETE FROM sites WHERE slug = 'quiz'");
  assert.equal(requests(sqlite).length, 0);
});

const SECRET = "slack-signing-secret";

async function sign(body, timestamp = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return { timestamp: String(timestamp), signature: `v0=${hex}` };
}

test("Slack signatures: right secret, untouched body, and recent", async () => {
  const body = "payload=%7B%7D";
  const { timestamp, signature } = await sign(body);
  assert.equal(await verifySlackSignature(SECRET, timestamp, signature, body), true);
  assert.equal(await verifySlackSignature("other", timestamp, signature, body), false);
  assert.equal(await verifySlackSignature(SECRET, timestamp, signature, `${body}x`), false);
  const old = await sign(body, Math.floor(Date.now() / 1000) - 600);
  assert.equal(await verifySlackSignature(SECRET, old.timestamp, old.signature, body), false);
  assert.equal(await verifySlackSignature(SECRET, null, signature, body), false);
});

test("Slack: a DM to the owner, and a click by the owner answers it", async () => {
  const { sqlite, env } = setup();
  Object.assign(env, { NAP_SLACK_BOT_TOKEN: "xoxb-test", NAP_SLACK_SIGNING_SECRET: SECRET });
  const before = napConfig.accessRequests;
  napConfig.accessRequests = { channels: ["slack"] };
  const realFetch = globalThis.fetch;
  const calls = [];
  const slackEmails = { U_OWNER: OWNER, U_ANNA: ANNA };
  globalThis.fetch = async (url, init) => {
    const method = String(url).replace("https://slack.com/api/", "");
    const body = init.headers["content-type"].startsWith("application/json")
      ? JSON.parse(init.body)
      : Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ method, body, auth: init.headers.authorization });
    const reply = {
      "users.lookupByEmail": { ok: body.email === OWNER, user: { id: "U_OWNER" } },
      "chat.postMessage": { ok: true, channel: "D_OWNER", ts: "1.2" },
      "users.info": { ok: true, user: { profile: { email: slackEmails[body.user] } } },
      "chat.update": { ok: true },
    }[method] ?? { ok: false, error: "unknown_method" };
    return new Response(JSON.stringify(reply));
  };
  try {
    await visit(env, ANNA, "request");
    const [request] = requests(sqlite);
    assert.deepEqual(JSON.parse(request.channel_refs), {
      slack: { channel: "D_OWNER", ts: "1.2" },
    });
    const post = calls.find((call) => call.method === "chat.postMessage");
    assert.equal(post.auth, "Bearer xoxb-test");
    assert.equal(post.body.channel, "U_OWNER");
    const buttons = post.body.blocks.find((block) => block.type === "actions").elements;
    assert.deepEqual(
      buttons.map((button) => [button.action_id, button.value]),
      [
        ["access:add", request.id],
        ["access:everyone", request.id],
        ["access:deny", request.id],
      ],
    );

    const click = async (user, actionId, signed = true) => {
      const body = new URLSearchParams({
        payload: JSON.stringify({
          type: "block_actions",
          user: { id: user },
          actions: [{ action_id: actionId, value: request.id }],
        }),
      }).toString();
      const { timestamp, signature } = signed
        ? await sign(body)
        : { timestamp: "1", signature: "v0=x" };
      return respond(
        env,
        handleSlackHook(
          new Request("https://nap.test/_nap/hooks/slack", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-slack-request-timestamp": timestamp,
              "x-slack-signature": signature,
            },
            body,
          }),
          PLACE,
        ),
      );
    };

    assert.equal((await click("U_OWNER", "access:add", false)).status, 401);
    // Someone the message was forwarded to cannot answer it.
    assert.equal((await click("U_ANNA", "access:add")).status, 200);
    assert.equal(requests(sqlite)[0].status, "pending");

    assert.equal((await click("U_OWNER", "access:add")).status, 200);
    assert.equal(requests(sqlite)[0].status, "approved");
    const update = calls.find((call) => call.method === "chat.update");
    assert.equal(update.body.channel, "D_OWNER");
    assert.equal(update.body.ts, "1.2");
    assert.match(update.body.text, /You added Anna Andersson/);
  } finally {
    globalThis.fetch = realFetch;
    napConfig.accessRequests = before;
  }
});
