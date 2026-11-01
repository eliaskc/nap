/**
 * window.nap, the client Nap serves to every site and artifact at /_nap/client.js: collections
 * (nap.db), channels, voice calls, nap.fetch, and nap.me. It is built into one classic script
 * (see vite.config.ts), so pages load it with a plain <script> tag. Its types are api.d.ts,
 * served at /_nap/client.d.ts.
 */
import type { Nap } from "./api";
import { channel } from "./channel";
import { collection, me } from "./db";
import { NapError } from "./errors";
import { proxyFetch } from "./fetch";
import { voice } from "./voice";

const nap: Nap = Object.freeze({
  channel,
  voice,
  fetch: proxyFetch,
  db: Object.freeze({ collection }),
  me,
  NapError,
} as unknown as Nap);

Object.defineProperty(window, "nap", { value: nap, enumerable: true });
