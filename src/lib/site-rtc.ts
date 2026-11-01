import { json, type Identity } from "~/lib/nap-server";
import { canViewSite } from "~/lib/site-data";

/** How long TURN credentials last. Pages ask again before they expire (nap.voice does). */
const TTL_SECONDS = 4 * 60 * 60;
const STUN_ONLY = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

export type RtcEnv = {
  DB: D1Database;
  /** A Cloudflare Realtime TURN key. Without both, pages get STUN only. */
  NAP_TURN_KEY_ID?: string;
  NAP_TURN_KEY_API_TOKEN?: string;
};

type IceServer = { urls: string | string[]; username?: string; credential?: string };

/**
 * GET /_nap/rtc: ICE servers for WebRTC between the people on a nap, as
 * `new RTCPeerConnection({ iceServers })` takes them. With a TURN key, they include short-lived
 * Cloudflare TURN credentials, so calls connect on networks that block direct connections.
 * The TURN key itself never leaves the Worker.
 */
export async function handleRtcRequest(
  env: RtcEnv,
  slug: string,
  request: Request,
  identity: Identity,
) {
  const headers = { "cache-control": "no-store" };
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, { status: 405, headers });
  }
  if (!(await canViewSite(env.DB, slug, identity.email))) {
    return json({ error: "Site not found" }, { status: 404, headers });
  }
  const turn = await turnServers(env);
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
  return json(
    turn
      ? { iceServers: turn, turn: true, expiresAt }
      : { iceServers: STUN_ONLY, turn: false, expiresAt: null },
    { headers },
  );
}

async function turnServers(env: RtcEnv): Promise<IceServer[] | null> {
  const keyId = env.NAP_TURN_KEY_ID;
  const token = env.NAP_TURN_KEY_API_TOKEN;
  if (!keyId || !token) return null;
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      },
    );
    if (!response.ok) {
      console.error(
        JSON.stringify({ message: "TURN credentials failed", status: response.status }),
      );
      return null;
    }
    const body = (await response.json()) as { iceServers?: IceServer[] };
    if (!Array.isArray(body.iceServers) || !body.iceServers.length) return null;
    // Browsers block port 53, and waiting for it to time out only slows a call down.
    return body.iceServers.map((server) => ({
      ...server,
      urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
        (url) => !/:53(\?|$)/.test(url),
      ),
    }));
  } catch (error) {
    console.error(JSON.stringify({ message: "TURN credentials failed", error: String(error) }));
    return null;
  }
}
