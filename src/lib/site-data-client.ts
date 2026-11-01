import { client, voice, voiceVersion } from "virtual:nap-client";
import CLIENT_TYPES from "~/client/api.d.ts?raw";

const headers = {
  "cache-control": "public, max-age=300",
  "x-content-type-options": "nosniff",
};

/** /_nap/client.js: window.nap, built from src/client. */
export function serveSiteDataClient() {
  return new Response(client, {
    headers: { "content-type": "text/javascript; charset=utf-8", ...headers },
  });
}

/**
 * /_nap/client-voice.js: the voice engine, which client.js imports as an ES module. Artifact
 * frames have an opaque origin, so it allows every origin. client.js asks for it by version, and
 * that URL never changes, so browsers keep it.
 */
export function serveVoiceEngine(request: Request) {
  const current = new URL(request.url).searchParams.get("v") === voiceVersion;
  return new Response(voice, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "cache-control": current ? "public, max-age=31536000, immutable" : "public, max-age=300",
    },
  });
}

/** /_nap/client.d.ts: its types, for sites written in TypeScript. */
export function serveClientTypes() {
  return new Response(CLIENT_TYPES, {
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}
