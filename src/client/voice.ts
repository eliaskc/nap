import type { NapVoiceCall, NapVoiceEvents } from "./api";
import { channel } from "./channel";
import { NapError, toNapError } from "./errors";
import { emitTo, napJson } from "./paths";
import type { VoiceEngine, VoiceEngineInitial } from "./voice-engine";

/** The engine's build, so a new client.js never runs against a cached older engine. */
declare const __NAP_VOICE_VERSION__: string;

// Voice: one audio call among the pages on a channel. The call itself (WebRTC, the microphone,
// Effect) is voice-engine.ts, served as /_nap/client-voice.js and loaded the first time a page
// asks for a call, so pages without voice stay small. One object per name; voice(name)
// returns it until close().
const voices = new Map<string, NapVoiceCall>();

type Events = NapVoiceEvents;

// Where client.js came from: the engine sits next to it. Read now, while the script runs.
const scriptSource =
  typeof document !== "undefined" && document.currentScript && "src" in document.currentScript
    ? document.currentScript.src
    : "";

let engineModule: Promise<typeof import("./voice-engine")> | null = null;

function loadEngineModule() {
  engineModule ??= import(
    /* @vite-ignore */ new URL(
      "client-voice.js?v=" + __NAP_VOICE_VERSION__,
      scriptSource || new URL("/_nap/", location.href),
    ).href
  ) as Promise<typeof import("./voice-engine")>;
  // A failed load (offline, say) can be tried again by the next call.
  engineModule.catch(() => (engineModule = null));
  return engineModule;
}

export function voice(name = "voice"): NapVoiceCall {
  const existing = voices.get(name);
  if (existing) return existing;
  const room = channel(name);
  const listeners: { [E in keyof Events]: Set<(value: Events[E]) => void> } = {
    change: new Set(),
    error: new Set(),
  };
  let engine: VoiceEngine | null = null;
  let closed = false;
  // What the page chose before the engine was there.
  const initial: VoiceEngineInitial = { muted: false, meta: null, inputId: null };
  const canSelectInput = Boolean(
    typeof navigator !== "undefined" &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.enumerateDevices === "function" &&
    typeof RTCRtpSender === "function" &&
    "replaceTrack" in RTCRtpSender.prototype,
  );

  function emit<E extends keyof Events>(event: E, value: Events[E]) {
    emitTo(listeners[event] as Set<(value: Events[E]) => void>, value);
  }
  const changed = () => emit("change", api);

  let loading: Promise<VoiceEngine> | null = null;
  function load() {
    loading ??= loadEngineModule().then(
      (module) => {
        if (closed) throw new NapError("This voice call is closed", 400);
        engine = module.createVoiceEngine(
          name,
          {
            room,
            NapError,
            loadIceServers: () => napJson("rtc"),
            changed,
            error: (error) => emit("error", error),
          },
          initial,
        );
        changed();
        return engine;
      },
      (error: unknown) => {
        loading = null;
        const napError = new NapError("Voice could not load: " + toNapError(error).message, 503);
        emit("error", napError);
        throw napError;
      },
    );
    return loading;
  }
  // Start loading now: by the time someone clicks Join, the engine is there, so the join
  // happens during the click, as browsers require for sound.
  load().catch(() => undefined);

  const api: NapVoiceCall = Object.freeze({
    name,
    get status() {
      return engine ? engine.status : "idle";
    },
    get joined() {
      return engine ? engine.status === "joined" : false;
    },
    get muted() {
      return engine ? engine.muted : initial.muted;
    },
    get canSelectInput() {
      return engine ? engine.canSelectInput : canSelectInput;
    },
    get inputs() {
      return engine ? engine.inputs : [];
    },
    get input() {
      return engine ? engine.input : initial.inputId;
    },
    get participants() {
      return engine ? engine.participants : [];
    },
    async join() {
      if (closed) throw new NapError("This voice call is closed", 400);
      return (engine ?? (await load())).join();
    },
    leave() {
      engine?.leave();
    },
    setMuted(next: boolean) {
      if (engine) return engine.setMuted(next);
      initial.muted = Boolean(next);
      changed();
    },
    setMeta(next: unknown) {
      if (engine) return engine.setMeta(next);
      initial.meta = next === undefined ? null : next;
      changed();
    },
    async setInput(deviceId: string | null) {
      if (engine) return engine.setInput(deviceId);
      initial.inputId = deviceId || null;
      changed();
    },
    on<E extends keyof Events>(event: E, listener: (value: Events[E]) => void) {
      const set = Object.hasOwn(listeners, event)
        ? (listeners[event] as Set<(value: Events[E]) => void>)
        : undefined;
      if (!set) throw new TypeError("Unknown voice event: " + String(event));
      set.add(listener);
      return () => void set.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      voices.delete(name);
      if (engine) engine.close();
      else room.leave();
    },
  } satisfies NapVoiceCall);
  voices.set(name, api);
  return api;
}
