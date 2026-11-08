// The main module of a channel server's Dynamic Worker (see site-channel.ts). Nap loads it as
// source, next to the site's own code as "server.js", and runs the class below as a facet of the
// channel's Durable Object. It has no network access and no bindings: it only hears what the
// channel object tells it, and answers with the messages to send and how often to tick.
//
// Plain JavaScript, because it runs as it is: it is not bundled with Nap.
import { DurableObject } from "cloudflare:workers";
import * as site from "./server.js";

const MAX_TICK_RATE = 30;

export class ChannelServer extends DurableObject {
  #server = null;
  #peers = new Map();
  #out = [];
  #tickRate = 0;
  #lastTick = 0;

  /** Starts the site's server with the people already connected. */
  async start(name, peers) {
    return this.#run(async () => {
      const Server = site.default;
      if (typeof Server !== "function") {
        throw new TypeError("The server file must `export default class { ... }`");
      }
      for (const peer of peers) this.#peers.set(peer.id, peer);
      this.#server = new Server(this.#api(name));
      for (const peer of peers) await this.#server.join?.(peer);
    });
  }

  /** Someone joined. start() may have had them already, when they joined while it started. */
  async join(peer) {
    return this.#run(async () => {
      if (this.#peers.has(peer.id)) return;
      this.#peers.set(peer.id, peer);
      await this.#server?.join?.(peer);
    });
  }

  async leave(id) {
    return this.#run(async () => {
      const peer = this.#peers.get(id);
      if (!peer) return;
      this.#peers.delete(id);
      await this.#server?.leave?.(peer);
    });
  }

  async presence(id, state) {
    return this.#run(async () => {
      const peer = this.#peers.get(id);
      if (!peer) return;
      peer.state = state;
      await this.#server?.presence?.(peer);
    });
  }

  async message(id, data) {
    return this.#run(async () => {
      const peer = this.#peers.get(id);
      if (peer) await this.#server?.message?.(peer, data);
    });
  }

  async tick() {
    return this.#run(async () => {
      const now = Date.now();
      const dt = this.#lastTick ? (now - this.#lastTick) / 1000 : 1 / (this.#tickRate || 1);
      this.#lastTick = now;
      await this.#server?.tick?.(dt);
    });
  }

  /** What the site's server gets. */
  #api(name) {
    const host = this;
    return Object.freeze({
      name,
      get peers() {
        return [...host.#peers.values()];
      },
      send(data, options = {}) {
        const to = options?.to;
        if (to !== undefined && to !== null && typeof to !== "string") {
          throw new TypeError("send(data, { to }): to is a peer id");
        }
        host.#out.push({ to: to ?? null, data: data === undefined ? null : data });
      },
      setTickRate(rate) {
        const hz = Number(rate);
        host.#tickRate = Number.isFinite(hz) ? Math.max(0, Math.min(MAX_TICK_RATE, hz)) : 0;
        host.#lastTick = 0;
      },
      get tickRate() {
        return host.#tickRate;
      },
      storage: this.ctx.storage.kv,
    });
  }

  /** Runs one call into the site's code. Messages sent before an error still go out. */
  async #run(call) {
    let error = null;
    try {
      await call();
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.stack || thrown.message : String(thrown);
    }
    const out = this.#out;
    this.#out = [];
    return { out, tickRate: this.#tickRate, error };
  }
}
