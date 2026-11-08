/**
 * window.nap, the client Nap serves to every site and artifact at /_nap/client.js: collections
 * (nap.db), channels, voice calls, nap.fetch, nap.notify, nap.me, nap.people, avatars (<nap-avatar>), and the
 * deployment's extensions (nap.<name>, see nap.extension.ts). It is built into one classic script
 * (see vite.config.ts), so pages load it with a plain <script> tag. Its types are api.d.ts,
 * served at /_nap/client.d.ts.
 */
import type { Nap } from "./api";
import { channel } from "./channel";
import { collection, me } from "./db";
import { NapError } from "./errors";
import { extensionApis } from "./extensions";
import { proxyFetch } from "./fetch";
import { canNotify, notify } from "./notify";
import { avatar, defineAvatarElement, looks, people } from "./people";
import { voice } from "./voice";

const nap: Nap = Object.freeze({
  // The deployment's extensions first, so they can never replace Nap's own names.
  ...extensionApis(),
  channel,
  voice,
  fetch: proxyFetch,
  notify,
  canNotify,
  db: Object.freeze({ collection }),
  me,
  people,
  avatar,
  looks,
  NapError,
} as unknown as Nap);

Object.defineProperty(window, "nap", { value: nap, enumerable: true });
defineAvatarElement();
