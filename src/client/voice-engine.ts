/**
 * The voice call itself (nap.voice), loaded by voice.ts the first time a page asks for a call,
 * so pages without voice never download it. It is written with Effect: a call is one fiber
 * with a scope, and everything the call opens (the microphone, the audio context, the
 * connections to the others, the timers) is released when that scope closes, whether the
 * person leaves, the join fails halfway, or the channel goes away.
 *
 * Each pair of pages in the call connects directly with WebRTC; the channel carries only
 * presence ({ inCall, muted, meta }) and the offers, answers, and candidates between them.
 * /_nap/rtc gives TURN servers for networks that block direct connections.
 */
import { Cause, Data, Effect, Exit, Fiber, Schedule, Scope, ScopedRef } from "effect";
import type {
  NapChannel,
  NapError,
  NapErrorConstructor,
  NapPeer,
  NapVoiceInput,
  NapVoiceParticipant,
  NapVoiceStatus,
} from "./api";

/** What voice.ts gives the engine. Shared with the main client, so classes and channels match. */
export type VoiceEngineDeps = {
  room: NapChannel;
  NapError: NapErrorConstructor;
  /** GET /_nap/rtc. */
  loadIceServers: () => Promise<IceAnswer>;
  changed: () => void;
  error: (error: NapError) => void;
};

/** Choices the page made before the engine loaded. */
export type VoiceEngineInitial = { muted: boolean; meta: unknown; inputId: string | null };

export interface VoiceEngine {
  readonly status: NapVoiceStatus;
  readonly muted: boolean;
  readonly canSelectInput: boolean;
  readonly inputs: Array<NapVoiceInput>;
  readonly input: string | null;
  readonly participants: Array<NapVoiceParticipant>;
  join(): Promise<void>;
  leave(): void;
  setMuted(muted: boolean): void;
  setMeta(meta: unknown): void;
  setInput(deviceId: string | null): Promise<void>;
  close(): void;
}

type IceAnswer = { iceServers: Array<RTCIceServer>; expiresAt: string | null };
type VoicePresence = { inCall?: boolean; muted?: boolean; meta?: unknown } | null;
type Signal =
  | { voice: "description"; description: RTCSessionDescriptionInit }
  | { voice: "candidate"; candidate: RTCIceCandidateInit };
type Link = {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  state: RTCPeerConnectionState;
  sender?: RTCRtpSender;
};
type Level = {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Float32Array<ArrayBuffer>;
  speaking: boolean;
  loudAt: number;
};
/** What a running call holds, for the event handlers outside its fiber. */
type Call = {
  scope: Scope.Scope;
  mic: ScopedRef.ScopedRef<MediaStream>;
  audioContext: AudioContext | null;
};

const STUN_ONLY: Array<RTCIceServer> = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
const SPEAKING_LEVEL = 0.015;
const SPEAKING_HOLD_MS = 400;
/** Ask for new TURN credentials half an hour before they expire, and at most once a minute. */
const ICE_REFRESH_EARLY_MS = 30 * 60 * 1000;
const ICE_REFRESH_MIN_MS = 60 * 1000;
const ICE_TIMEOUT = "8 seconds";

// Why a microphone could not be opened. The page sees them as NapErrors (403, 404, 500).
class MicDenied extends Data.TaggedError("MicDenied")<{ cause: unknown }> {}
class NoMic extends Data.TaggedError("NoMic")<{ cause: unknown }> {}
/** The chosen microphone is gone (unplugged, or another browser profile's id). */
class MicGone extends Data.TaggedError("MicGone")<{ cause: unknown }> {}
class MicFailed extends Data.TaggedError("MicFailed")<{ cause: unknown }> {}
class NoIceServers extends Data.TaggedError("NoIceServers")<{ cause?: unknown }> {}

const noop = () => undefined;

function stopTracks(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

function audioConstraints(deviceId: string | null): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio };
}

/** One getUserMedia call, with its failures sorted into what the page can do about them. */
const getUserMedia = (deviceId: string | null) =>
  Effect.tryPromise({
    try: () => navigator.mediaDevices.getUserMedia(audioConstraints(deviceId)),
    catch: (cause) => {
      const name = (cause as Error | null)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") return new MicDenied({ cause });
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        return deviceId ? new MicGone({ cause }) : new NoMic({ cause });
      }
      return new MicFailed({ cause });
    },
  });

export function createVoiceEngine(
  name: string,
  deps: VoiceEngineDeps,
  initial: VoiceEngineInitial,
): VoiceEngine {
  const { room, NapError } = deps;
  const links = new Map<string, Link>();
  // Peer id (or "self").
  const levels = new Map<string, Level>();
  let status: NapVoiceStatus = "idle";
  let muted = initial.muted;
  let meta = initial.meta;
  // The chosen microphone (null: the system default), the one in use, and the known inputs.
  let inputId = initial.inputId;
  let mic: MediaStream | null = null;
  let inputs: Array<NapVoiceInput> = [];
  let iceServers = STUN_ONLY;
  let call: Call | null = null;
  let callFiber: Fiber.Fiber<never, unknown> | null = null;
  // Each join gets its own token, so a call that is still shutting down cannot touch the next.
  let callToken: object | null = null;
  let joining: Promise<void> | null = null;
  let gestureArmed = false;
  let closed = false;
  const canSelectInput = Boolean(
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.enumerateDevices === "function" &&
    typeof RTCRtpSender === "function" &&
    "replaceTrack" in RTCRtpSender.prototype,
  );

  const changed = () => deps.changed();
  const fail = (error: unknown) => deps.error(toNapError(error));

  function toNapError(error: unknown): NapError {
    if (error instanceof NapError) return error;
    if (error instanceof MicDenied) return new NapError("Microphone access was denied", 403);
    if (error instanceof NoMic || error instanceof MicGone) {
      return new NapError("No microphone found", 404);
    }
    const cause = error instanceof MicFailed ? error.cause : error;
    const message = cause instanceof Error ? cause.message : String(cause);
    return new NapError(message || "Voice failed", 500);
  }

  function presenceOf(peer: NapPeer) {
    return peer.state as VoicePresence;
  }
  function inCall(peer: NapPeer) {
    return Boolean(presenceOf(peer)?.inCall);
  }
  function participants(): Array<NapVoiceParticipant> {
    return room.peers.filter(inCall).map((peer) => {
      const state = presenceOf(peer) ?? {};
      const level = levels.get(peer.self ? "self" : peer.id);
      const link = links.get(peer.id);
      return {
        id: peer.id,
        email: peer.email,
        name: peer.name,
        self: peer.self,
        muted: Boolean(state.muted),
        meta: state.meta === undefined ? null : state.meta,
        speaking: Boolean(level && level.speaking) && !state.muted,
        // This page's connection to the peer: "connecting", "connected", "failed", ...
        // null for this page, or while this page is not in the call.
        connection: peer.self || status !== "joined" ? null : link ? link.state : "connecting",
      };
    });
  }
  function publishPresence() {
    if (status === "joined") room.setPresence({ inCall: true, muted, meta });
  }

  // Microphones. Browsers only give their names once the page may use the microphone.
  async function loadInputs() {
    if (!canSelectInput) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const next = devices
        .filter((device) => device.kind === "audioinput" && device.deviceId)
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || "Microphone " + (index + 1),
        }));
      if (JSON.stringify(next) === JSON.stringify(inputs)) return;
      inputs = next;
      changed();
    } catch {
      // No device list in this browser.
    }
  }
  const onDeviceChange = () => void loadInputs();
  if (canSelectInput) {
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    // Lists the microphones now if the person already allowed one on this site.
    void loadInputs();
  }

  /** The chosen microphone, or the default one when it is gone. Stopped with the call. */
  const acquireMic = (deviceId: string | null) =>
    Effect.acquireRelease(
      getUserMedia(deviceId).pipe(
        Effect.catchTag("MicGone", () =>
          Effect.sync(() => {
            inputId = null;
          }).pipe(Effect.andThen(getUserMedia(null))),
        ),
      ),
      (stream) => Effect.sync(() => stopTracks(stream)),
    );

  /** Starts sending a microphone: mute state, speaking level, and unplugging. */
  function useMic(stream: MediaStream) {
    mic = stream;
    for (const track of stream.getAudioTracks()) {
      track.enabled = !muted;
      // Unplugged: carry on with the default microphone.
      track.addEventListener("ended", () => {
        if (status === "joined" && mic === stream) switchInput(null).catch(fail);
      });
    }
    unwatchLevel("self");
    watchLevel("self", stream);
  }

  /** Swaps the microphone during a call without reconnecting: the old one stops after. */
  const swapMic = (current: Call) =>
    Effect.gen(function* () {
      yield* ScopedRef.set(current.mic, acquireMic(inputId));
      const stream = yield* ScopedRef.get(current.mic);
      useMic(stream);
      const track = stream.getAudioTracks()[0];
      yield* Effect.forEach(
        [...links.values()],
        (entry) =>
          entry.sender
            ? Effect.tryPromise(() => entry.sender!.replaceTrack(track)).pipe(Effect.ignore)
            : Effect.void,
        { concurrency: "unbounded" },
      );
      void loadInputs();
    });

  async function switchInput(deviceId: string | null) {
    inputId = deviceId || null;
    const current = call;
    if (status !== "joined" || !current) return changed();
    // Runs in the call's scope, so leaving during the switch releases the new microphone too.
    const exit = await Effect.runPromiseExit(
      swapMic(current).pipe(Effect.forkIn(current.scope), Effect.flatMap(Fiber.join)),
    );
    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) return;
      throw toNapError(Cause.squash(exit.cause));
    }
    changed();
  }

  /** TURN servers from /_nap/rtc. Without them (or when Nap is slow), STUN only. */
  const fetchIceServers = Effect.tryPromise({
    try: () => deps.loadIceServers(),
    catch: (cause) => new NoIceServers({ cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: ICE_TIMEOUT,
      orElse: () => Effect.fail(new NoIceServers({})),
    }),
    Effect.catchTag("NoIceServers", (error) =>
      Effect.sync((): IceAnswer => {
        console.warn("Nap voice: no TURN servers, some networks will not connect", error.cause);
        return { iceServers: STUN_ONLY, expiresAt: null };
      }),
    ),
  );

  /** Asks for new TURN credentials before they expire, for as long as the call lasts. */
  const keepIceServersFresh = (first: IceAnswer) =>
    Effect.gen(function* () {
      let expiresAt = first.expiresAt;
      while (expiresAt) {
        const wait = Date.parse(expiresAt) - Date.now() - ICE_REFRESH_EARLY_MS;
        yield* Effect.sleep(Math.max(wait, ICE_REFRESH_MIN_MS));
        const next = yield* fetchIceServers;
        iceServers = next.iceServers;
        expiresAt = next.expiresAt;
        for (const link of links.values()) {
          try {
            link.pc.setConfiguration({ iceServers });
          } catch {
            // Closed.
          }
        }
      }
    });

  /** Waits for the next click or key press. Interrupting it removes the listeners. */
  const nextGesture = Effect.callback<void>((resume) => {
    const done = () => {
      removeEventListener("pointerdown", done, true);
      removeEventListener("keydown", done, true);
      resume(Effect.void);
    };
    addEventListener("pointerdown", done, true);
    addEventListener("keydown", done, true);
    return Effect.sync(() => {
      removeEventListener("pointerdown", done, true);
      removeEventListener("keydown", done, true);
    });
  });

  // Browsers only start sound after a click on the page. A page that joins without one (such
  // as on load, to stay in the call across pages) starts its sound at the first click or key.
  function resumeOnGesture() {
    const current = call;
    if (gestureArmed || !current) return;
    gestureArmed = true;
    Effect.runFork(
      nextGesture.pipe(
        Effect.andThen(
          Effect.sync(() => {
            const context = current.audioContext;
            if (context && context.state === "suspended") context.resume().catch(noop);
            for (const entry of links.values()) {
              if (entry.audio.srcObject && entry.audio.paused) entry.audio.play().catch(noop);
            }
          }),
        ),
        Effect.ensuring(Effect.sync(() => (gestureArmed = false))),
        Effect.forkIn(current.scope),
      ),
    );
  }

  // Speaking: the loudness of each stream.
  function watchLevel(key: string, stream: MediaStream) {
    const context = call?.audioContext;
    if (!context) return;
    try {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      levels.set(key, {
        source,
        analyser,
        data: new Float32Array(analyser.fftSize),
        speaking: false,
        loudAt: 0,
      });
    } catch {
      // No Web Audio for this stream: it never shows as speaking.
    }
  }
  function unwatchLevel(key: string) {
    const level = levels.get(key);
    if (!level) return;
    try {
      level.source.disconnect();
    } catch {
      // Already gone.
    }
    levels.delete(key);
  }
  /** Checks every stream's loudness ten times a second, for as long as the call lasts. */
  const meterLevels = Effect.sync(() => {
    const now = Date.now();
    let any = false;
    for (const level of levels.values()) {
      level.analyser.getFloatTimeDomainData(level.data);
      let sum = 0;
      for (const value of level.data) sum += value * value;
      if (Math.sqrt(sum / level.data.length) > SPEAKING_LEVEL) level.loudAt = now;
      const speaking = now - level.loudAt < SPEAKING_HOLD_MS;
      if (speaking !== level.speaking) {
        level.speaking = speaking;
        any = true;
      }
    }
    if (any) changed();
  }).pipe(Effect.repeat(Schedule.spaced("100 millis")));

  // One connection per other person in the call ("perfect negotiation": both sides may offer,
  // and the polite side gives way when offers cross). The call's scope closes them all.
  function link(peerId: string) {
    const existing = links.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers });
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.hidden = true;
    document.body.appendChild(audio);
    const entry: Link = {
      pc,
      audio,
      polite: (room.id ?? "") > peerId,
      makingOffer: false,
      ignoreOffer: false,
      state: "connecting",
    };
    links.set(peerId, entry);
    const signal = (data: Signal) => room.send(data, { to: peerId });
    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        signal({ voice: "description", description: pc.localDescription!.toJSON() });
      } catch (error) {
        if (links.get(peerId) === entry) fail(error);
      } finally {
        entry.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) signal({ voice: "candidate", candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      if (audio.srcObject === stream) return;
      audio.srcObject = stream;
      audio.play().catch(resumeOnGesture);
      unwatchLevel(peerId);
      watchLevel(peerId, stream);
    };
    pc.onconnectionstatechange = () => {
      entry.state = pc.connectionState;
      if (pc.connectionState === "failed") pc.restartIce();
      changed();
    };
    if (mic) for (const track of mic.getTracks()) entry.sender = pc.addTrack(track, mic);
    return entry;
  }
  function unlink(peerId: string) {
    const entry = links.get(peerId);
    if (!entry) return;
    links.delete(peerId);
    entry.pc.close();
    entry.audio.srcObject = null;
    entry.audio.remove();
    unwatchLevel(peerId);
  }

  async function onSignal(peerId: string, data: Signal) {
    const entry = link(peerId);
    const pc = entry.pc;
    try {
      if (data.voice === "description") {
        const description = data.description;
        const collision =
          description.type === "offer" && (entry.makingOffer || pc.signalingState !== "stable");
        entry.ignoreOffer = !entry.polite && collision;
        if (entry.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          room.send(
            { voice: "description", description: pc.localDescription!.toJSON() },
            { to: peerId },
          );
        }
      } else if (data.voice === "candidate") {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (error) {
          if (!entry.ignoreOffer) throw error;
        }
      }
    } catch (error) {
      if (links.get(peerId) === entry) fail(error);
    }
  }

  // Connect to everyone in the call, and drop whoever left it.
  function sync() {
    if (status === "joined") {
      const others = new Set(
        room.peers.filter((peer) => !peer.self && inCall(peer)).map((peer) => peer.id),
      );
      for (const peerId of [...links.keys()]) if (!others.has(peerId)) unlink(peerId);
      for (const peerId of others) link(peerId);
    }
    changed();
  }

  /**
   * Ends the call's visible state at once: no connections, no microphone, out of the call in
   * presence. The call's scope runs it too, so it does not matter which comes first, and it
   * does nothing for a call that is no longer the current one.
   */
  function teardown(token: object | null) {
    if (!token || token !== callToken) return;
    callToken = null;
    const wasInCall = status === "joined";
    status = "idle";
    joining = null;
    for (const peerId of [...links.keys()]) unlink(peerId);
    unwatchLevel("self");
    if (mic) stopTracks(mic);
    mic = null;
    call = null;
    if (wasInCall && room.status !== "closed") room.setPresence(null);
  }

  /** The call: everything it opens is released when its scope closes. */
  const runCall = (token: object, audioContext: AudioContext | null, onJoined: () => void) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      if (audioContext) {
        yield* Effect.addFinalizer(() => Effect.sync(() => void audioContext.close().catch(noop)));
      }
      yield* Effect.addFinalizer(() => Effect.sync(() => teardown(token)));
      const [micRef, ice] = yield* Effect.all(
        [ScopedRef.fromAcquire(acquireMic(inputId)), fetchIceServers],
        { concurrency: "unbounded" },
      );
      // Left while the microphone was opening: the scope releases it.
      if (token !== callToken) return yield* Effect.interrupt;
      iceServers = ice.iceServers;
      call = { scope, mic: micRef, audioContext };
      yield* Effect.forkScoped(keepIceServersFresh(ice));
      if (audioContext && audioContext.state === "suspended") {
        audioContext.resume().catch(noop);
        // resume() is async: still suspended means the browser wants a click first.
        if ((audioContext.state as AudioContextState) !== "running") resumeOnGesture();
      }
      useMic(yield* ScopedRef.get(micRef));
      yield* Effect.forkScoped(meterLevels);
      status = "joined";
      void loadInputs();
      publishPresence();
      sync();
      onJoined();
      return yield* Effect.never;
    }).pipe(Effect.scoped);

  function join(): Promise<void> {
    if (closed) return Promise.reject(new NapError("This voice call is closed", 400));
    if (status === "joined") return Promise.resolve();
    if (joining) return joining;
    if (!navigator.mediaDevices || typeof RTCPeerConnection !== "function") {
      return Promise.reject(new NapError("Voice needs a browser with WebRTC, on https", 400));
    }
    const token = {};
    callToken = token;
    status = "joining";
    changed();
    // Made now, during the click, so the browser lets it play.
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    let audioContext: AudioContext | null = null;
    try {
      audioContext = AudioContextClass ? new AudioContextClass() : null;
    } catch {
      // No Web Audio: the call works, without speaking indicators.
    }
    const pending = new Promise<void>((resolve, reject) => {
      let joined = false;
      const fiber = Effect.runFork(
        runCall(token, audioContext, () => {
          joined = true;
          joining = null;
          resolve();
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (callFiber === fiber) callFiber = null;
              teardown(token);
              if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
                if (!joined) resolve();
                return;
              }
              const error = toNapError(Cause.squash(exit.cause));
              fail(error);
              changed();
              if (!joined) reject(error);
            }),
          ),
        ),
      );
      callFiber = fiber;
    });
    joining = pending;
    return pending;
  }

  function leave() {
    const fiber = callFiber;
    callFiber = null;
    teardown(callToken);
    if (fiber) Effect.runFork(Fiber.interrupt(fiber));
  }

  const offPresence = room.on("presence", sync);
  const offMessage = room.on("message", ({ from, data }) => {
    const signal = data as Signal | null;
    if (status !== "joined" || !signal || typeof signal.voice !== "string" || from.id === room.id) {
      return;
    }
    void onSignal(from.id, signal);
  });
  const offStatus = room.on("status", (next) => {
    if (next === "closed" && status !== "idle") leave();
    changed();
  });
  const offError = room.on("error", (error) => deps.error(error));

  return {
    get status() {
      return status;
    },
    get muted() {
      return muted;
    },
    canSelectInput,
    get inputs() {
      return inputs;
    },
    get input() {
      const track = mic && mic.getAudioTracks()[0];
      const settings = track && track.getSettings ? track.getSettings() : null;
      return (settings && settings.deviceId) || inputId;
    },
    get participants() {
      return participants();
    },
    join,
    leave() {
      leave();
      changed();
    },
    setMuted(next) {
      muted = Boolean(next);
      if (mic) for (const track of mic.getAudioTracks()) track.enabled = !muted;
      publishPresence();
      changed();
    },
    setMeta(next) {
      meta = next === undefined ? null : next;
      publishPresence();
      changed();
    },
    setInput(deviceId) {
      return switchInput(deviceId).catch((error) => {
        const napError = toNapError(error);
        fail(napError);
        throw napError;
      });
    },
    close() {
      if (closed) return;
      closed = true;
      leave();
      offPresence();
      offMessage();
      offStatus();
      offError();
      if (canSelectInput) {
        navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
      }
      room.leave();
    },
  };
}
