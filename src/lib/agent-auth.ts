import { json, type Identity } from "~/lib/nap-server";

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

type AuthEnv = { DB: D1Database; DRAFT_LIMITER?: RateLimit };

export type AgentIdentity = Identity & { tokenId: string; client: string };

const noStore = { "cache-control": "no-store" };

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function randomString(byteLength: number) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

/** Fields from a JSON body, a form body, or the query string. */
export async function readParams(request: Request, url: URL) {
  const params: Record<string, string> = Object.fromEntries(url.searchParams);
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    for (const [key, value] of Object.entries(body ?? {})) {
      if (typeof value === "string") params[key] = value;
    }
  } else if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData().catch(() => null);
    for (const [key, value] of form?.entries() ?? []) {
      if (typeof value === "string") params[key] = value;
    }
  }
  return params;
}

function oauthError(error: string, description: string, status = 400) {
  return json({ error, error_description: description }, { status, headers: noStore });
}

/** POST /_nap/api/auth/device — { client?: "Pi on elias-mbp" } */
export async function startDeviceLogin(env: AuthEnv, request: Request, url: URL) {
  if (request.method !== "POST") return json({ error: "Use POST" }, { status: 405 });
  if (env.DRAFT_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.DRAFT_LIMITER.limit({ key: `device:${ip}` });
    if (!success) return oauthError("slow_down", "Too many sign-in attempts. Wait a minute.", 429);
  }

  const params = await readParams(request, url);
  const client = cleanClientName(params.client ?? params.client_name ?? "");
  const cf = (request as Request & { cf?: { city?: string; country?: string } }).cf;
  const requestedFrom = [cf?.city, cf?.country].filter(Boolean).join(", ").slice(0, 120);
  const deviceCode = randomString(32);
  const expiresAt = new Date(Date.now() + DEVICE_CODE_SECONDS * 1000).toISOString();

  let userCode = "";
  for (let attempt = 0; attempt < 5 && !userCode; attempt++) {
    const candidate = newUserCode();
    try {
      await env.DB.prepare(
        `INSERT INTO device_codes (device_code_hash, user_code, client_name, requested_from, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(await sha256Hex(deviceCode), candidate, client, requestedFrom, expiresAt)
        .run();
      userCode = candidate;
    } catch (error) {
      if (!/UNIQUE/i.test(String(error))) throw error;
    }
  }
  if (!userCode) return json({ error: "Could not start sign-in. Try again." }, { status: 503 });

  await env.DB.prepare(
    `DELETE FROM device_codes WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`,
  ).run();

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
}

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
export async function exchangeDeviceCode(env: AuthEnv, request: Request, url: URL) {
  if (request.method !== "POST") return json({ error: "Use POST" }, { status: 405 });
  const params = await readParams(request, url);
  const deviceCode = params.device_code ?? "";
  if (!deviceCode) return oauthError("invalid_request", "Send device_code.");

  const hash = await sha256Hex(deviceCode);
  const row = await env.DB.prepare(
    `SELECT ${DEVICE_COLUMNS} FROM device_codes WHERE device_code_hash = ?`,
  )
    .bind(hash)
    .first<DeviceRow>();
  if (!row) return oauthError("invalid_grant", "Unknown device code. Start the sign-in again.");
  if (row.tokenId) return oauthError("invalid_grant", "This code was already used. Start again.");
  if (row.deniedAt) return oauthError("access_denied", "The user denied the request.");
  if (Date.parse(row.expiresAt) <= Date.now()) {
    return oauthError("expired_token", "The code expired. Start the sign-in again.");
  }

  if (!row.approvedAt || !row.approvedByEmail) {
    const tooSoon =
      row.lastPolledAt &&
      Date.now() - Date.parse(row.lastPolledAt) < (POLL_INTERVAL_SECONDS - 1) * 1000;
    await env.DB.prepare(
      `UPDATE device_codes SET last_polled_at = ${NOW} WHERE device_code_hash = ?`,
    )
      .bind(hash)
      .run();
    return tooSoon
      ? oauthError("slow_down", `Poll at most every ${POLL_INTERVAL_SECONDS} seconds.`)
      : oauthError("authorization_pending", "Waiting for the user to approve.");
  }

  const token = `nap_${randomString(32)}`;
  const tokenId = randomString(9);
  // One transaction. The token exists only if this request was the one that used the code.
  const [taken, inserted] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE device_codes SET token_id = ?
       WHERE device_code_hash = ? AND token_id IS NULL AND approved_at IS NOT NULL`,
    ).bind(tokenId, hash),
    env.DB.prepare(
      `INSERT INTO agent_tokens (id, token_hash, email, client_name)
       SELECT ?, ?, approved_by_email, client_name FROM device_codes
       WHERE device_code_hash = ? AND token_id = ?`,
    ).bind(tokenId, await sha256Hex(token), hash, tokenId),
  ]);
  if (taken.meta.changes !== 1 || inserted.meta.changes !== 1) {
    return oauthError("invalid_grant", "This code was already used. Start again.");
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
}

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
export async function describeDeviceRequest(db: D1Database, code: string) {
  const userCode = normalizeUserCode(code);
  const row = userCode
    ? await db
        .prepare(`SELECT ${DEVICE_COLUMNS} FROM device_codes WHERE user_code = ?`)
        .bind(userCode)
        .first<DeviceRow>()
    : null;
  if (!row) return json({ error: "Code not found" }, { status: 404, headers: noStore });
  const request: DeviceRequest = {
    userCode: row.userCode,
    clientName: row.clientName,
    requestedFrom: row.requestedFrom,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: deviceStatus(row),
  };
  return json({ request }, { headers: noStore });
}

/** POST /api/connect/:code — { action: "approve" | "deny" }. The caller is signed in with Access. */
export async function decideDeviceRequest(
  db: D1Database,
  identity: Identity,
  code: string,
  action: unknown,
) {
  if (action !== "approve" && action !== "deny") {
    return json({ error: 'action must be "approve" or "deny"' }, { status: 400 });
  }
  const userCode = normalizeUserCode(code);
  if (!userCode) return json({ error: "Code not found" }, { status: 404 });

  const result =
    action === "approve"
      ? await db
          .prepare(
            `UPDATE device_codes SET approved_by_email = ?, approved_at = ${NOW}
             WHERE user_code = ? AND approved_at IS NULL AND denied_at IS NULL AND expires_at > ${NOW}`,
          )
          .bind(identity.email, userCode)
          .run()
      : await db
          .prepare(
            `UPDATE device_codes SET denied_at = ${NOW}
             WHERE user_code = ? AND approved_at IS NULL AND denied_at IS NULL`,
          )
          .bind(userCode)
          .run();
  if (result.meta.changes !== 1) {
    return json({ error: "This code expired or was already used" }, { status: 409 });
  }
  return json({ ok: true, status: action === "approve" ? "approved" : "denied" });
}

/**
 * Checks `Authorization: Bearer nap_…`. The agent API is outside Access, so this is the only
 * check. Never use getIdentity() there: its headers come from Access, and Access does not run.
 */
export async function authenticateAgent(
  db: D1Database,
  request: Request,
): Promise<AgentIdentity | Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  const invalid = () =>
    json(
      {
        error: "Missing or unknown token. Sign in again with POST /_nap/api/auth/device.",
        code: "invalid_token",
      },
      { status: 401, headers: { ...noStore, "www-authenticate": 'Bearer realm="nap"' } },
    );
  if (!TOKEN_PATTERN.test(token)) return invalid();

  const row = await db
    .prepare(
      `SELECT agent_tokens.id, agent_tokens.email, agent_tokens.client_name AS client,
              profiles.display_name AS name,
              profiles.last_seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${ACTIVE_DAYS} days') AS active
       FROM agent_tokens
       LEFT JOIN profiles ON profiles.email = agent_tokens.email
       WHERE agent_tokens.token_hash = ? AND agent_tokens.revoked_at IS NULL`,
    )
    .bind(await sha256Hex(token))
    .first<{
      id: string;
      email: string;
      client: string;
      name: string | null;
      active: number | null;
    }>();
  if (!row) return invalid();
  if (!row.active) {
    return json(
      {
        error: `This token is paused because ${row.email} has not opened Nap for ${ACTIVE_DAYS} days. Ask the user to open ${new URL(request.url).origin} in a browser, then try again.`,
        code: "inactive",
      },
      { status: 401, headers: noStore },
    );
  }

  await db
    .prepare(
      `UPDATE agent_tokens SET last_used_at = ${NOW}
       WHERE id = ? AND (last_used_at IS NULL
         OR last_used_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute'))`,
    )
    .bind(row.id)
    .run();

  return { email: row.email, name: row.name ?? row.email, tokenId: row.id, client: row.client };
}

export type AgentToken = {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export async function listAgentTokens(db: D1Database, email: string) {
  const { results } = await db
    .prepare(
      `SELECT id, client_name AS clientName, created_at AS createdAt, last_used_at AS lastUsedAt
       FROM agent_tokens WHERE email = ? AND revoked_at IS NULL
       ORDER BY COALESCE(last_used_at, created_at) DESC`,
    )
    .bind(email)
    .all<AgentToken>();
  return results;
}

export async function revokeAgentToken(db: D1Database, email: string, id: string) {
  const result = await db
    .prepare(
      `UPDATE agent_tokens SET revoked_at = ${NOW}
       WHERE id = ? AND email = ? AND revoked_at IS NULL`,
    )
    .bind(id, email)
    .run();
  if (result.meta.changes !== 1) return json({ error: "Token not found" }, { status: 404 });
  return json({ ok: true });
}
