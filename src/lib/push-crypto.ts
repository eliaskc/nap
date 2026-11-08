import { importPKCS8, SignJWT } from "jose";

/**
 * The crypto for push, with WebCrypto only: web push payload encryption (RFC 8291, aes128gcm),
 * VAPID request signing (RFC 8292), and the APNs provider token. Plain async functions; the
 * Effect code in notifications.ts calls them.
 */

const encoder = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

export function base64url(bytes: Uint8Array) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Bytes {
  const plain = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = plain + "=".repeat((4 - (plain.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function concat(...parts: Array<Uint8Array>): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** The VAPID key pair as stored: JWKs. */
export type VapidKeys = { publicJwk: JsonWebKey; privateJwk: JsonWebKey };

export async function newVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    publicJwk: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey,
    privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
  };
}

/** The public key as browsers want it for applicationServerKey: the raw point, base64url. */
export function vapidPublicKey(keys: VapidKeys) {
  const x = fromBase64url(keys.publicJwk.x!);
  const y = fromBase64url(keys.publicJwk.y!);
  return base64url(concat(new Uint8Array([4]), x, y));
}

/** The Authorization header for a push service: a VAPID JWT for the endpoint's origin. */
export async function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string) {
  const key = await crypto.subtle.importKey(
    "jwk",
    keys.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const jwt = await new SignJWT({ sub: subject })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setAudience(new URL(endpoint).origin)
    .setExpirationTime("12h")
    .sign(key);
  return `vapid t=${jwt}, k=${vapidPublicKey(keys)}`;
}

/**
 * Encrypts a payload for one browser subscription (RFC 8291): one aes128gcm record, with a fresh
 * key pair and salt each time.
 */
export async function encryptWebPush(payload: Bytes, p256dh: string, auth: string) {
  const receiverPublic = fromBase64url(p256dh);
  const authSecret = fromBase64url(auth);
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const receiverKey = await crypto.subtle.importKey(
    "raw",
    receiverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, pair.privateKey, 256),
  );
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(encoder.encode("WebPush: info\0"), receiverPublic, senderPublic),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the payload, then the last-record delimiter.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      concat(payload, new Uint8Array([2])),
    ),
  );
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([senderPublic.byteLength]), senderPublic, sealed);
}

/**
 * The APNs provider token. Apple wants the same one reused for 20 to 60 minutes, so it is kept
 * for 40 minutes per key.
 */
let cachedApnsToken: { key: string; token: string; at: number } | null = null;

export async function apnsToken(keyId: string, teamId: string, pem: string) {
  const cacheKey = `${keyId}:${teamId}`;
  if (cachedApnsToken?.key === cacheKey && Date.now() - cachedApnsToken.at < 40 * 60_000) {
    return cachedApnsToken.token;
  }
  const key = await importPKCS8(pem.replace(/\\n/g, "\n"), "ES256");
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt()
    .sign(key);
  cachedApnsToken = { key: cacheKey, token, at: Date.now() };
  return token;
}
