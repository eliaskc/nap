import { Effect } from "effect";
import type {
  AccessDecision,
  AccessRequestChannel,
  AccessRequestInfo,
} from "~/lib/access-requests";
import { decideAccessRequest, isAccessDecision } from "~/lib/access-requests";
import { EVERYONE_LABEL } from "~/lib/deployment-text";
import type { NapPlace } from "~/lib/nap-urls";
import { failText, HttpError } from "~/server/http";
import { inBackground, Settings, type SlackApp } from "~/server/platform";

/**
 * The Slack channel for access requests. The Nap Slack app sends the owner a direct message with
 * buttons; a click comes back to /_nap/hooks/slack, which Access lets through. The Worker checks
 * Slack's signature, then asks Slack for the clicker's email, and decideAccessRequest checks that
 * they own the nap, so a forwarded message cannot be answered by someone else.
 *
 * The Slack app needs the bot scopes chat:write, users:read, and users:read.email, and
 * Interactivity on with the request URL https://<root>/_nap/hooks/slack.
 */

type SlackResponse = { ok: boolean; error?: string; [key: string]: unknown };

/** One Slack Web API call. Never fails: a network error is `{ ok: false }`. */
const callSlack = (
  app: SlackApp,
  method: string,
  params: Record<string, unknown>,
  /** users.* methods take form fields, not JSON. */
  form = false,
) =>
  Effect.promise(async (): Promise<SlackResponse> => {
    try {
      const response = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${app.botToken}`,
          "content-type": form
            ? "application/x-www-form-urlencoded"
            : "application/json; charset=utf-8",
        },
        body: form
          ? new URLSearchParams(params as Record<string, string>).toString()
          : JSON.stringify(params),
      });
      return (await response.json()) as SlackResponse;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

const logSlackError = (what: string, response: SlackResponse) =>
  Effect.logWarning(`Slack ${what} failed`).pipe(
    Effect.annotateLogs({ error: response.error ?? "unknown" }),
  );

/** Slack's mrkdwn: these three must be escaped in text. */
const esc = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const nameOf = (request: AccessRequestInfo) =>
  request.requesterName?.trim() || request.requesterEmail;
const firstName = (request: AccessRequestInfo) =>
  request.requesterName?.trim().split(/\s+/)[0] || request.requesterEmail;

function pendingBlocks(request: AccessRequestInfo) {
  const what = request.kind === "artifact" ? "artifact" : "site";
  const who = request.requesterName
    ? `*${esc(request.requesterName)}* (${esc(request.requesterEmail)})`
    : `*${esc(request.requesterEmail)}*`;
  const now =
    request.visibility === "private"
      ? "Only you can open it right now."
      : "It's shared with a few people right now.";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${who} asks for access to your ${what} *<${request.napUrl}|${esc(request.title)}>*.`,
      },
    },
    { type: "context", elements: [{ type: "mrkdwn", text: now }] },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          action_id: "access:add",
          value: request.id,
          text: { type: "plain_text", text: `Add ${firstName(request)}`.slice(0, 75) },
        },
        {
          type: "button",
          action_id: "access:everyone",
          value: request.id,
          text: {
            type: "plain_text",
            text: `Share with ${EVERYONE_LABEL.toLowerCase()}`.slice(0, 75),
          },
        },
        {
          type: "button",
          action_id: "access:deny",
          value: request.id,
          text: { type: "plain_text", text: "Deny" },
        },
      ],
    },
  ];
}

function answeredText(request: AccessRequestInfo) {
  const who = esc(nameOf(request));
  const title = `*<${request.napUrl}|${esc(request.title)}>*`;
  if (request.decision === "add") return `:white_check_mark: You added ${who} to ${title}.`;
  if (request.decision === "everyone") {
    return `:globe_with_meridians: ${title} is shared with ${esc(EVERYONE_LABEL.toLowerCase())}, so ${who} can open it.`;
  }
  return `:no_entry_sign: You turned down ${who}'s request for ${title}.`;
}

function answeredBlocks(request: AccessRequestInfo) {
  return [{ type: "section", text: { type: "mrkdwn", text: answeredText(request) } }];
}

const slackApp = Effect.gen(function* () {
  return (yield* Settings).slack;
});

export const slackChannel: AccessRequestChannel = {
  name: "slack",
  label: "Slack",
  send: (request) =>
    Effect.gen(function* () {
      const app = yield* slackApp;
      if (!app) {
        yield* Effect.logWarning("Access requests go to Slack, but the Slack app is not set up");
        return null;
      }
      const user = yield* callSlack(
        app,
        "users.lookupByEmail",
        { email: request.ownerEmail },
        true,
      );
      const userId = (user.user as { id?: string } | undefined)?.id;
      if (!user.ok || !userId) {
        yield* logSlackError("users.lookupByEmail", user);
        return null;
      }
      const posted = yield* callSlack(app, "chat.postMessage", {
        channel: userId,
        text: `${nameOf(request)} asks for access to ${request.title}`,
        blocks: pendingBlocks(request),
        unfurl_links: false,
      });
      if (!posted.ok) {
        yield* logSlackError("chat.postMessage", posted);
        return null;
      }
      return { channel: String(posted.channel), ts: String(posted.ts) };
    }),
  answered: (request, ref) =>
    Effect.gen(function* () {
      const app = yield* slackApp;
      if (!app || typeof ref.channel !== "string" || typeof ref.ts !== "string") return;
      const updated = yield* callSlack(app, "chat.update", {
        channel: ref.channel,
        ts: ref.ts,
        text: answeredText(request),
        blocks: answeredBlocks(request),
      });
      if (!updated.ok) yield* logSlackError("chat.update", updated);
    }),
};

const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

/** Slack's request signature: v0=HMAC-SHA256(signing secret, "v0:<timestamp>:<body>"). */
export async function verifySlackSignature(
  signingSecret: string,
  timestamp: string | null,
  signature: string | null,
  body: string,
  now = Date.now(),
) {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > SIGNATURE_MAX_AGE_SECONDS) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const expected = `v0=${Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

type BlockActionsPayload = {
  type?: string;
  user?: { id?: string };
  response_url?: string;
  actions?: Array<{ action_id?: string; value?: string }>;
};

/**
 * /_nap/hooks/slack. Access lets this path through: never use getIdentity() here. Slack wants an
 * answer within three seconds, so the work happens after the response.
 */
export const handleSlackHook = Effect.fn("handleSlackHook")(function* (
  request: Request,
  place: NapPlace,
) {
  const app = yield* slackApp;
  if (!app) return yield* failText(404, "Not found");
  if (request.method !== "POST") return yield* failText(405, "Method not allowed");
  const body = yield* Effect.promise(() => request.text());
  const valid = yield* Effect.promise(() =>
    verifySlackSignature(
      app.signingSecret,
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      body,
    ),
  );
  if (!valid) return yield* failText(401, "Bad signature");

  let payload: BlockActionsPayload = {};
  try {
    payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "{}") as BlockActionsPayload;
  } catch {
    return yield* failText(400, "Bad payload");
  }
  const action = payload.actions?.[0];
  const decision = action?.action_id?.startsWith("access:")
    ? action.action_id.slice("access:".length)
    : "";
  if (payload.type !== "block_actions" || !isAccessDecision(decision) || !action?.value) {
    return new Response(null, { status: 200 });
  }
  yield* inBackground(
    answerFromSlack(
      app,
      payload.user?.id ?? "",
      action.value,
      decision,
      payload.response_url,
      place,
    ),
    "Answering an access request from Slack failed",
  );
  return new Response(null, { status: 200 });
});

const answerFromSlack = Effect.fn("answerFromSlack")(function* (
  app: SlackApp,
  userId: string,
  id: string,
  decision: AccessDecision,
  responseUrl: string | undefined,
  place: NapPlace,
) {
  const info = yield* callSlack(app, "users.info", { user: userId }, true);
  const email = (info.user as { profile?: { email?: string } } | undefined)?.profile?.email ?? "";
  /** Answers through the message's response URL, which needs no token. */
  const respond = (message: Record<string, unknown>) =>
    responseUrl?.startsWith("https://hooks.slack.com/")
      ? Effect.promise(() =>
          fetch(responseUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(message),
          }).catch(() => undefined),
        ).pipe(Effect.asVoid)
      : Effect.void;
  const tell = (text: string) =>
    respond({ response_type: "ephemeral", replace_original: false, text });
  if (!info.ok || !email) {
    yield* logSlackError("users.info", info);
    return yield* tell(
      "Nap couldn't tell who you are on Slack. Answer the request on Nap instead.",
    );
  }
  const result = yield* decideAccessRequest(email, id, decision, place).pipe(
    Effect.catchIf(
      (error): error is HttpError => error instanceof HttpError,
      (error) =>
        Effect.succeed({
          error:
            typeof error.body === "object" && error.body && "error" in error.body
              ? String((error.body as { error: unknown }).error)
              : "Something went wrong",
        }),
    ),
  );
  if ("error" in result) return yield* tell(result.error);
  // Answered somewhere else first: show that here, in case this message missed it.
  if (!result.changed) {
    yield* respond({
      replace_original: true,
      text: answeredText(result.request),
      blocks: answeredBlocks(result.request),
    });
  }
});
