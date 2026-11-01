import CLIENT_SOURCE from "virtual:nap-client";
import CLIENT_TYPES from "~/client/api.d.ts?raw";

const headers = {
  "cache-control": "public, max-age=300",
  "x-content-type-options": "nosniff",
};

/** /_nap/client.js: window.nap, built from src/client. */
export function serveSiteDataClient() {
  return new Response(CLIENT_SOURCE, {
    headers: { "content-type": "text/javascript; charset=utf-8", ...headers },
  });
}

/** /_nap/client.d.ts: its types, for sites written in TypeScript. */
export function serveClientTypes() {
  return new Response(CLIENT_TYPES, {
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });
}
