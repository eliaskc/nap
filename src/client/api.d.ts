/**
 * Types for window.nap, the client Nap serves to every site at /_nap/client.js. Sites written
 * in TypeScript can download this file from /_nap/client.d.ts.
 */

/** A failed Nap call. `status` is the HTTP status; a 409 carries the current `document`. */
export interface NapError extends Error {
  readonly name: "NapError";
  readonly status: number;
  /** On a 409: the document as it is now, or null when it is gone. */
  readonly document?: NapDocument | null;
}

export interface NapErrorConstructor {
  new (message: string, status: number, document?: NapDocument | null): NapError;
  readonly prototype: NapError;
}

export type NapShape = "circle" | "triangle" | "cloud" | "pill" | "drop" | "clover" | "diamond";
export type NapColor = "red" | "orange" | "green" | "violet" | "pink" | "brown" | "blue";

/**
 * A person on Nap: the name they chose and their look. Each shape and colour pair belongs to one
 * person on this Nap, so it tells people apart at a glance.
 */
export interface NapPerson {
  email: string;
  name: string;
  shape: NapShape;
  color: NapColor;
}

/** The person viewing the page. */
export type NapIdentity = NapPerson;

/** Nap's shapes (SVG paths in a 100 × 100 box) and colours, for pages that draw people themselves. */
export interface NapLooks {
  shapes: Array<NapShape>;
  colors: Array<NapColor>;
  shapePaths: Record<NapShape, string>;
  colorValues: Record<NapColor, string>;
}

export interface NapAvatarOptions {
  /** Width and height in CSS pixels. Default 32. */
  size?: number;
  /** Draw the initials inside. Default true. */
  initials?: boolean;
}

// Collections (nap.db)

export interface NapDocument<T = Record<string, unknown>> {
  id: string;
  data: T;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A change from the changes feed: a document, or `{ id, deleted: true }`. */
export type NapChange<T = Record<string, unknown>> =
  | NapDocument<T>
  | { id: string; deleted: true; version?: number };

export interface NapWriteOptions {
  /** Fails with 409 when the document's version is not this one. */
  ifVersion?: number;
  /** Only creates (put). */
  ifNew?: boolean;
}

export interface NapSubscribeOptions {
  /** How often to check for changes without a live connection, in ms (at least 1000). */
  interval?: number;
  onError?: (error: NapError) => void;
}

export interface NapCollection<T = Record<string, unknown>> {
  list(options?: {
    limit?: number;
    cursor?: string;
  }): Promise<{ documents: Array<NapDocument<T>>; nextCursor: string | null }>;
  get(id: string): Promise<NapDocument<T>>;
  create(data: T): Promise<NapDocument<T>>;
  /** Replaces a document that exists. `{ ifVersion }` also fails if someone saved in between. */
  update(id: string, data: T, options?: NapWriteOptions): Promise<NapDocument<T>>;
  /** Creates or replaces the document with this id. `{ ifNew: true }` only creates. */
  put(id: string, data: T, options?: NapWriteOptions): Promise<NapDocument<T>>;
  /** Merges fields into a document (JSON Merge Patch: null removes a field). */
  patch(id: string, data: Partial<T>, options?: NapWriteOptions): Promise<NapDocument<T>>;
  delete(id: string, options?: NapWriteOptions): Promise<void>;
  changes(options?: {
    since?: number;
    limit?: number;
  }): Promise<{ changes: Array<NapChange<T>>; since: number; hasMore: boolean }>;
  /** Calls back with every document, newest first, now and after each change. Returns stop. */
  subscribe(
    callback: (documents: Array<NapDocument<T>>) => void,
    options?: NapSubscribeOptions,
  ): () => void;
}

// Channels (nap.channel)

export interface NapPeer<S = unknown> {
  id: string;
  email: string;
  name: string;
  shape: NapShape;
  color: NapColor;
  joinedAt: number;
  state: S | null;
  /** This page. */
  self: boolean;
}

export type NapChannelStatus = "connecting" | "open" | "closed";

export interface NapChannelEvents<S = unknown, M = unknown> {
  presence: Array<NapPeer<S>>;
  join: NapPeer<S>;
  leave: NapPeer<S>;
  message: { from: NapPeer<S>; data: M };
  status: NapChannelStatus;
  error: NapError;
}

export interface NapChannel<S = unknown, M = unknown> {
  readonly name: string;
  /** This page's peer id, once connected. */
  readonly id: string | null;
  readonly status: NapChannelStatus;
  /** Everyone connected, this page included (self: true), oldest first. */
  readonly peers: Array<NapPeer<S>>;
  /** The longest-connected peer. Every page agrees on it, so it can run shared state. */
  readonly host: NapPeer<S> | null;
  readonly isHost: boolean;
  on<E extends keyof NapChannelEvents<S, M>>(
    event: E,
    listener: (value: NapChannelEvents<S, M>[E]) => void,
  ): () => void;
  /** To every other page, or to one peer id with `{ to }`. False when not connected. */
  send(data: M, options?: { to?: string }): boolean;
  /** This page's state for everyone, up to 1 KB. Sent at most 20 times a second. */
  setPresence(state: S | null): void;
  leave(): void;
}

// Voice (nap.voice)

export type NapVoiceStatus = "idle" | "joining" | "joined";

export interface NapVoiceParticipant<M = unknown> {
  id: string;
  email: string;
  name: string;
  self: boolean;
  muted: boolean;
  speaking: boolean;
  meta: M | null;
  /**
   * This page's connection to the person ("connecting", "connected", "failed", ...). Null for
   * this page, and while this page is not in the call.
   */
  connection: RTCPeerConnectionState | null;
}

export interface NapVoiceInput {
  deviceId: string;
  label: string;
}

export interface NapVoiceEvents<M = unknown> {
  change: NapVoiceCall<M>;
  error: NapError;
}

export interface NapVoiceCall<M = unknown> {
  readonly name: string;
  readonly status: NapVoiceStatus;
  readonly joined: boolean;
  readonly muted: boolean;
  /** Whether this browser can switch microphones. */
  readonly canSelectInput: boolean;
  /** Microphones. Names appear once the person allowed the microphone. */
  readonly inputs: Array<NapVoiceInput>;
  /** The microphone in use (or chosen for the next join); null: the system default. */
  readonly input: string | null;
  /** Everyone in the call, this page included once joined (self: true), oldest first. */
  readonly participants: Array<NapVoiceParticipant<M>>;
  /** Chooses a microphone (null: the default). In a call it switches without reconnecting. */
  setInput(deviceId: string | null): Promise<void>;
  /** This page's own state for the others in the call, up to about 800 bytes. */
  setMeta(meta: M | null): void;
  /** Asks for the microphone and joins. Call it from a click. */
  join(): Promise<void>;
  leave(): void;
  setMuted(muted: boolean): void;
  on<E extends keyof NapVoiceEvents<M>>(
    event: E,
    listener: (value: NapVoiceEvents<M>[E]) => void,
  ): () => void;
  /** Leaves the call and the channel. */
  close(): void;
}

// Fetch (nap.fetch)

export interface NapFetchOptions {
  method?: "GET" | "HEAD";
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export interface Nap {
  db: { collection<T = Record<string, unknown>>(name: string): NapCollection<T> };
  channel<S = unknown, M = unknown>(name: string): NapChannel<S, M>;
  voice<M = unknown>(name?: string): NapVoiceCall<M>;
  /** Reads a public URL through Nap. The site lists the hosts in nap.json ("fetch"). */
  fetch(url: string | URL, options?: NapFetchOptions): Promise<Response>;
  /** The person viewing the page, with their name and look. */
  me(): Promise<NapIdentity>;
  /** Everyone on this Nap, or only these emails, with their names and looks. */
  people(emails?: Array<string>): Promise<Array<NapPerson>>;
  /** A person's avatar as an <svg> element. Plain HTML can use <nap-avatar> instead. */
  avatar(person: Pick<NapPerson, "name" | "shape" | "color">, options?: NapAvatarOptions): SVGSVGElement;
  looks: NapLooks;
  NapError: NapErrorConstructor;
}

declare global {
  interface Window {
    nap: Nap;
  }
  const nap: Nap;
}
