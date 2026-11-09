import HOST_SOURCE from "./channel-server-host.js?raw";
import { objectKey } from "~/lib/nap-server";

/**
 * Channel servers: a site's own JavaScript, named for a channel in its nap.json, that runs on Nap
 * as the authoritative host of that channel (a game's simulation, a shared timer, a referee).
 *
 * The channel's Durable Object (SiteChannel) keeps the sockets, access checks, and rate limits.
 * It loads the site's file into a Dynamic Worker with no network access and no bindings, and runs
 * it as a facet: a child of the channel object with its own SQLite storage, which the channel
 * object's own storage is out of reach of. channel-server-host.js wraps the site's class.
 *
 * Every call into the server goes through one queue, in the order the channel object saw the
 * events, and answers with the messages to send. The server never reaches the sockets itself.
 *
 * The server starts when the first person joins and stops when the last one leaves, so it runs
 * the version that was live when the channel filled. While it runs, a timer keeps the channel
 * object awake (it ticks the server, or does nothing at all), so the server keeps its memory.
 */

/** Who server messages come from, on the pages. */
export const SERVER_PEER = { id: "server", email: "", name: "Server", shape: "", color: "" };

const FACET = "server";
const MAX_SERVER_BYTES = 5 * 1024 * 1024;
const KEEP_AWAKE_MS = 10_000;
const COMPATIBILITY_DATE = "2026-06-13";

/** A peer as the server sees it. */
export type ServerPeer = {
  id: string;
  email: string;
  name: string;
  /** Null on a Nap without avatars. */
  shape: string | null;
  color: string | null;
  joinedAt: number;
  state: unknown;
};

/** What runs for a channel: a file in one site version. */
export type ServerCode = { slug: string; version: string; path: string; channel: string };

export type ServerMessage = { to: string | null; data: unknown };

type CallResult = { out: Array<ServerMessage>; tickRate: number; error: string | null };

/** The RPC methods of ChannelServer in channel-server-host.js. */
type ServerStub = {
  start(name: string, peers: Array<ServerPeer>): Promise<CallResult>;
  join(peer: ServerPeer): Promise<CallResult>;
  leave(id: string): Promise<CallResult>;
  presence(id: string, state: unknown): Promise<CallResult>;
  message(id: string, data: unknown): Promise<CallResult>;
  tick(): Promise<CallResult>;
};

export type ServerEnv = { LOADER?: WorkerLoader; SITES?: R2Bucket };

export type ServerIo = {
  /** The people connected now, oldest first. */
  peers(): Array<ServerPeer>;
  /** Sends what the server sent. */
  deliver(messages: Array<ServerMessage>): void;
  /** Tells the pages (or one of them) that the server failed, and logs it. */
  report(error: string, to?: string): void;
};

export class ChannelServerRunner {
  private code: ServerCode | null = null;
  private stub: ServerStub | null = null;
  private failed: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickRate = 0;
  private ticking = false;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: ServerEnv,
    private readonly io: ServerIo,
  ) {}

  /** Whether this Nap runs channel servers at all. */
  get enabled() {
    return Boolean(this.env.LOADER);
  }

  /** Whether a server runs, or tried to, for the people connected now. */
  get running() {
    return this.code !== null;
  }

  /**
   * `peer` joined. `code` is what the live version runs for this channel, if anything; it starts
   * the server when none runs. The new server gets everyone connected, `peer` included.
   */
  joined(peer: ServerPeer, code: ServerCode | null) {
    this.enqueue(async () => {
      if (!this.code) return code ? this.start(code) : undefined;
      if (this.failed) return this.io.report(this.failed, peer.id);
      await this.call((server) => server.join(peer));
    });
  }

  /** `id` left. With nobody left, the server stops. */
  left(id: string, remaining: number) {
    this.enqueue(async () => {
      await this.call((server) => server.leave(id));
      if (remaining === 0) this.stop();
    });
  }

  presence(id: string, state: unknown) {
    this.enqueue(() => this.call((server) => server.presence(id, state)));
  }

  /**
   * A page sent the server a message. `code` restarts a server that is gone while people are
   * still connected (the object restarted under hibernated sockets).
   */
  message(id: string, data: unknown, code: ServerCode | null) {
    this.enqueue(async () => {
      if (!this.code && code) await this.start(code);
      if (this.failed) return this.io.report(this.failed, id);
      await this.call((server) => server.message(id, data));
    });
  }

  private enqueue(work: () => Promise<unknown>) {
    this.queue = this.queue.then(work).then(
      () => undefined,
      (error) => this.io.report(errorText(error)),
    );
  }

  private async start(code: ServerCode) {
    this.code = code;
    this.failed = null;
    const loader = this.env.LOADER;
    const bucket = this.env.SITES;
    if (!loader || !bucket) return this.fail("Channel servers are off on this Nap");
    const worker = loader.get(`${code.slug}/${code.version}/${code.path}`, async () => {
      const object = await bucket.get(objectKey(code.slug, code.version, code.path));
      if (!object) throw new Error(`${code.path} is not in the site's live version`);
      if (object.size > MAX_SERVER_BYTES) throw new Error(`${code.path} is over 5 MB`);
      return {
        compatibilityDate: COMPATIBILITY_DATE,
        mainModule: "nap-channel-server.js",
        modules: { "nap-channel-server.js": HOST_SOURCE, "server.js": await object.text() },
        // No fetch() and no connect(): the server only talks to its channel.
        globalOutbound: null,
      };
    });
    this.stub = this.ctx.facets.get(FACET, () => ({
      class: worker.getDurableObjectClass("ChannelServer"),
    })) as unknown as ServerStub;
    const peers = this.io.peers();
    const result = await this.call((server) => server.start(code.channel, peers), false);
    if (!result || result.error) {
      return this.fail(result?.error ?? "The server did not start");
    }
    this.schedule();
  }

  /** The server cannot run: tell everyone, and answer each later message with the error. */
  private fail(error: string) {
    this.failed = `The channel server failed to start: ${error}`;
    this.halt();
    this.io.report(this.failed);
  }

  private stop() {
    this.halt();
    this.code = null;
    this.failed = null;
  }

  /** Stops the timer and the facet. Its storage stays. */
  private halt() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.tickRate = 0;
    if (this.stub) {
      try {
        this.ctx.facets.abort(FACET, new Error("The channel server stopped"));
      } catch {
        // Not running.
      }
    }
    this.stub = null;
  }

  /** Ticks at the server's rate, or only keeps the object awake while it has none. */
  private schedule() {
    clearInterval(this.timer);
    if (!this.stub) return;
    const rate = this.tickRate;
    this.timer = setInterval(
      () => {
        if (rate <= 0 || this.ticking) return;
        this.ticking = true;
        this.enqueue(async () => {
          try {
            await this.call((server) => server.tick());
          } finally {
            this.ticking = false;
          }
        });
      },
      rate > 0 ? 1000 / rate : KEEP_AWAKE_MS,
    );
  }

  /** One call into the server. Sends its messages and reports its error. */
  private async call(work: (server: ServerStub) => Promise<CallResult>, report = true) {
    if (!this.stub) return null;
    let result: CallResult;
    try {
      result = await work(this.stub);
    } catch (error) {
      // The isolate failed: it did not load, ran out of CPU or memory, or was aborted.
      if (!report) return { out: [], tickRate: 0, error: errorText(error) };
      this.io.report(errorText(error));
      return null;
    }
    if (result.out.length) this.io.deliver(result.out);
    if (result.error && report) this.io.report(result.error);
    if (result.tickRate !== this.tickRate) {
      this.tickRate = result.tickRate;
      this.schedule();
    }
    return result;
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
