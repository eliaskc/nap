import { Effect } from "effect";
import type { Identity } from "~/lib/nap-server";
import { Database, sql } from "~/server/database";
import { fail, failNoStore, json, noStore, readParams } from "~/server/http";
import { RateLimiter } from "~/server/platform";
import { randomString, sha256Hex } from "~/server/tokens";

/**
 * Agent sign-in, as in the OAuth device flow (RFC 8628):
 *
 * 1. The agent sends POST /_nap/api/auth/device and gets a device code and a user code.
 * 2. The user opens /connect?code=<user code>. Access protects that page. They approve.
 * 3. The agent polls POST /_nap/api/auth/token with the device code and gets a token.
 *
 * Access decides who can approve, so only people that Access allows can get a token. A token
 * works until it is revoked, but only while its owner still uses Nap through Access: see
 * ACTIVE_DAYS. Nap stores SHA-256 hashes of device codes and tokens, never the values.
 */

export const DEVICE_CODE_SECONDS = 10 * 60;
export const POLL_INTERVAL_SECONDS = 5;
/** A token stops working when its owner has not used Nap through Access for this long. */
export const ACTIVE_DAYS = 30;

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const TOKEN_PATTERN = /^nap_[A-Za-z0-9_-]{43}$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export type AgentIdentity = Identity & { tokenId: string; client: string };

/** Eight consonants, for example QXRT-KLMB. No vowels, so codes do not spell words. */
function newUserCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const letters = Array.from(bytes, (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
}

/** Accepts what people type: lower case, spaces, no dash. Returns "" for an impossible code. */
export function normalizeUserCode(value: string) {
  const letters = value.toUpperCase().replace(/[^A-Z]/g, "");
  if (letters.length !== 8 || [...letters].some((char) => !USER_CODE_ALPHABET.includes(char))) {
    return "";
  }
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

function cleanClientName(value: string) {
  const name = value
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return name || "Agent";
}

const oauthError = (error: string, description: string, status = 400) =>
  fail(status, error, { error_description: description }, noStore);

/** POST /_nap/api/auth/device — { client?: "Pi on elias-mbp" } */
export const startDeviceLogin = Effect.fn("startDeviceLogin")(function* (
  request: Request,
  url: URL,
) {
  if (request.method !== "POST") return yield* fail(405, "Use POST");
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(yield* (yield* RateLimiter).allow(`device:${ip}`))) {
    return yield* oauthError("slow_down", "Too many sign-in attempts. Wait a minute.", 429);
  }

  const params = yield* readParams(request, url);
  const client = cleanClientName(params.client ?? params.client_name ?? "");
  const cf = (request as Request & { cf?: { city?: string; country?: string } }).cf;
  const requestedFrom = [cf?.city, cf?.country].filter(Boolean).join(", ").slice(0, 120);
  const deviceCode = randomString(32);
  const expiresAt = new Date(Date.now() + DEVICE_CODE_SECONDS * 1000).toISOString();

  const db = yield* Database;
  const deviceCodeHash = yield* sha256Hex(deviceCode);
  let userCode = "";
  for (let attempt = 0; attempt < 5 && !userCode; attempt++) {
    const candidate = newUserCode();
    const inserted = yield* db
      .run(
        `INSERT INTO device_codes (device_code_hash, user_code, client_name, requested_from, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        deviceCodeHash,
        candidate,
        client,
        requestedFrom,
        expiresAt,
      )
      .pipe(
        Effect.as(true),
        // The user code is taken. Try another.
        Effect.catchIf(
          (error) => error.isConstraint,
          () => Effect.succeed(false),
        ),
      );
    if (inserted) userCode = candidate;
  }
  if (!userCode) return yield* fail(503, "Could not start sign-in. Try again.");

  yield* db.run(
    `DELETE FROM device_codes WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`,
  );

  const verificationUri = `${url.origin}/connect`;
  return json(
    {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${userCode}`,
      expires_in: DEVICE_CODE_SECONDS,
      interval: POLL_INTERVAL_SECONDS,
      message: `Ask the user to open ${verificationUri}?code=${userCode} and check that the code is ${userCode}. Then poll POST ${url.origin}/_nap/api/auth/token with device_code every ${POLL_INTERVAL_SECONDS} seconds.`,
    },
    { headers: noStore },
  );
});

type DeviceRow = {
  userCode: string;
  clientName: string;
  requestedFrom: string;
  createdAt: string;
  expiresAt: string;
  lastPolledAt: string | null;
  approvedByEmail: string | null;
  approvedAt: string | null;
  deniedAt: string | null;
  tokenId: string | null;
};

const DEVICE_COLUMNS = `user_code AS userCode, client_name AS clientName, requested_from AS requestedFrom,
  created_at AS createdAt, expires_at AS expiresAt, last_polled_at AS lastPolledAt,
  approved_by_email AS approvedByEmail, approved_at AS approvedAt, denied_at AS deniedAt,
  token_id AS tokenId`;

/** POST /_nap/api/auth/token — { device_code } */
export const exchangeDeviceCode = Effect.fn("exchangeDeviceCode")(function* (
  request: Request,
  url: URL,
) {
  if (request.method !== "POST") return yield* fail(405, "Use POST");
  const params = yield* readParams(request, url);
  const deviceCode = params.device_code ?? "";
  if (!deviceCode) return yield* oauthError("invalid_request", "Send device_code.");

  const db = yield* Database;
  const hash = yield* sha256Hex(deviceCode);
  const row = yield* db.first<DeviceRow>(
    `SELECT ${DEVICE_COLUMNS} FROM device_codes WHERE device_code_hash = ?`,
    hash,
  );
  if (!row) {
    return yield* oauthError("invalid_grant", "Unknown device code. Start the sign-in again.");
  }
  if (row.tokenId) {
    return yield* oauthError("invalid_grant", "This code was already used. Start again.");
  }
  if (row.deniedAt) return yield* oauthError("access_denied", "The user denied the request.");
  if (Date.parse(row.expiresAt) <= Date.now()) {
    return yield* oauthError("expired_token", "The code expired. Start the sign-in again.");
  }

  if (!row.approvedAt || !row.approvedByEmail) {
    const tooSoon =
      row.lastPolledAt &&
      Date.now() - Date.parse(row.lastPolledAt) < (POLL_INTERVAL_SECONDS - 1) * 1000;
    yield* db.run(
      `UPDATE device_codes SET last_polled_at = ${NOW} WHERE device_code_hash = ?`,
      hash,
    );
    return yield* tooSoon
      ? oauthError("slow_down", `Poll at most every ${POLL_INTERVAL_SECONDS} seconds.`)
      : oauthError("authorization_pending", "Waiting for the user to approve.");
  }

  const token = `nap_${randomString(32)}`;
  const tokenId = randomString(9);
  const tokenHash = yield* sha256Hex(token);
  // One transaction. The token exists only if this request was the one that used the code.
  const [taken, inserted] = yield* db.batch([
    sql(
      `UPDATE device_codes SET token_id = ?
       WHERE device_code_hash = ? AND token_id IS NULL AND approved_at IS NOT NULL`,
      tokenId,
      hash,
    ),
    sql(
      `INSERT INTO agent_tokens (id, token_hash, email, client_name)
       SELECT ?, ?, approved_by_email, client_name FROM device_codes
       WHERE device_code_hash = ? AND token_id = ?`,
      tokenId,
      tokenHash,
      hash,
      tokenId,
    ),
  ]);
  if (taken.changes !== 1 || inserted.changes !== 1) {
    return yield* oauthError("invalid_grant", "This code was already used. Start again.");
  }

  return json(
    {
      token,
      access_token: token,
      token_type: "Bearer",
      email: row.approvedByEmail,
      client: row.clientName,
      message: `Save the token in ~/.config/nap/${url.host}/token with mode 600. Send it as Authorization: Bearer <token>.`,
    },
    { headers: noStore },
  );
});

export type DeviceRequest = {
  userCode: string;
  clientName: string;
  requestedFrom: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
};

function deviceStatus(row: DeviceRow): DeviceRequest["status"] {
  if (row.approvedAt) return "approved";
  if (row.deniedAt) return "denied";
  if (Date.parse(row.expiresAt) <= Date.now()) return "expired";
  return "pending";
}

/** GET /api/connect/:code — what the approval page shows. */
export const describeDeviceRequest = Effect.fn("describeDeviceRequest")(function* (code: string) {
  const userCode = normalizeUserCode(code);
  const db = yield* Database;
  const row = userCode
    ? yield* db.first<DeviceRow>(
        `SELECT ${DEVICE_COLUMNS} FROM device_codes WHERE user_code = ?`,
        userCode,
      )
    : null;
  if (!row) return yield* failNoStore(404, "Code not found");
  const request: DeviceRequest = {
    userCode: row.userCode,
    clientName: row.clientName,
    requestedFrom: row.requestedFrom,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: deviceStatus(row),
  };
  return json({ request }, { headers: noStore });
});

/** POST /api/connect/:code — { action: "approve" | "deny" }. The caller is signed in with Access. */
export const decideDeviceRequest = Effect.fn("decideDeviceRequest")(function* (
  identity: Identity,
  code: string,
  action: unknown,
) {
  if (action !== "approve" && action !== "deny") {
    return yield* fail(400, 'action must be "approve" or "deny"');
  }
  const userCode = normalizeUserCode(code);
  if (!userCode) return yield* fail(404, "Code not found");

  const db = yield* Database;
  const result =
    action === "approve"
      ? yield* db.run(
          `UPDATE device_codes SET approved_by_email = ?, approved_at = ${NOW}
           WHERE user_code = ? AND approved_at IS NULL AND denied_at IS NULL AND expires_at > ${NOW}`,
          identity.email,
          userCode,
        )
      : yield* db.run(
          `UPDATE device_codes SET denied_at = ${NOW}
           WHERE user_code = ? AND approved_at IS NULL AND denied_at IS NULL`,
          userCode,
        );
  if (result.changes !== 1) {
    return yield* fail(409, "This code expired or was already used");
  }
  return json({ ok: true, status: action === "approve" ? "approved" : "denied" });
});

/**
 * Checks `Authorization: Bearer nap_…`. The agent API is outside Access, so this is the only
 * check. Never use getIdentity() there: its headers come from Access, and Access does not run.
 */
export const authenticateAgent = Effect.fn("authenticateAgent")(function* (request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  const invalid = () =>
    fail(
      401,
      "Missing or unknown token. Sign in again with POST /_nap/api/auth/device.",
      { code: "invalid_token" },
      { ...noStore, "www-authenticate": 'Bearer realm="nap"' },
    );
  if (!TOKEN_PATTERN.test(token)) return yield* invalid();

  const db = yield* Database;
  const row = yield* db.first<{
    id: string;
    email: string;
    client: string;
    name: string | null;
    active: number | null;
  }>(
    `SELECT agent_tokens.id, agent_tokens.email, agent_tokens.client_name AS client,
            profiles.display_name AS name,
            profiles.last_seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${ACTIVE_DAYS} days') AS active
     FROM agent_tokens
     LEFT JOIN profiles ON profiles.email = agent_tokens.email
     WHERE agent_tokens.token_hash = ? AND agent_tokens.revoked_at IS NULL`,
    yield* sha256Hex(token),
  );
  if (!row) return yield* invalid();
  if (!row.active) {
    return yield* failNoStore(
      401,
      `This token is paused because ${row.email} has not opened Nap for ${ACTIVE_DAYS} days. Ask the user to open ${new URL(request.url).origin} in a browser, then try again.`,
      { code: "inactive" },
    );
  }

  yield* db.run(
    `UPDATE agent_tokens SET last_used_at = ${NOW}
     WHERE id = ? AND (last_used_at IS NULL
       OR last_used_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute'))`,
    row.id,
  );

  const identity: AgentIdentity = {
    email: row.email,
    name: row.name ?? row.email,
    tokenId: row.id,
    client: row.client,
  };
  return identity;
});

export type AgentToken = {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export const listAgentTokens = Effect.fn("listAgentTokens")(function* (email: string) {
  const db = yield* Database;
  return yield* db.all<AgentToken>(
    `SELECT id, client_name AS clientName, created_at AS createdAt, last_used_at AS lastUsedAt
     FROM agent_tokens WHERE email = ? AND revoked_at IS NULL
     ORDER BY COALESCE(last_used_at, created_at) DESC`,
    email,
  );
});

export const revokeAgentToken = Effect.fn("revokeAgentToken")(function* (
  email: string,
  id: string,
) {
  const db = yield* Database;
  const result = yield* db.run(
    `UPDATE agent_tokens SET revoked_at = ${NOW}
     WHERE id = ? AND email = ? AND revoked_at IS NULL`,
    id,
    email,
  );
  if (result.changes !== 1) return yield* fail(404, "Token not found");
  return json({ ok: true });
});
