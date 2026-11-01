import type {
  NapPeer,
  NapVoiceCall,
  NapVoiceEvents,
  NapVoiceInput,
  NapVoiceParticipant,
  NapVoiceStatus,
} from "./api";
import { channel } from "./channel";
import { NapError, toNapError } from "./errors";
import { emitTo, napJson } from "./paths";

// Voice: one audio call among the pages on a channel. Each pair of pages in the call connects
// directly with WebRTC; the channel carries only presence ({ inCall, muted }) and the
// offers, answers, and candidates between them. /_nap/rtc gives TURN servers for networks
// that block direct connections. One object per name; voice(name) returns it until close().
const voices = new Map<string, NapVoiceCall>();
const STUN_ONLY: Array<RTCIceServer> = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
const SPEAKING_LEVEL = 0.015;
const SPEAKING_HOLD_MS = 400;

type Events = NapVoiceEvents;
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

export function voice(name = "voice"): NapVoiceCall {
  const existing = voices.get(name);
  if (existing) return existing;
  const room = channel(name);
  const listeners: { [E in keyof Events]: Set<(value: Events[E]) => void> } = {
    change: new Set(),
    error: new Set(),
  };
  const links = new Map<string, Link>();
  // Peer id (or "self").
  const levels = new Map<string, Level>();
  let status: NapVoiceStatus = "idle";
  let muted = false;
  let mic: MediaStream | null = null;
  let iceServers = STUN_ONLY;
  let iceTimer: ReturnType<typeof setTimeout> | undefined;
  let levelTimer: ReturnType<typeof setInterval> | undefined;
  let audioContext: AudioContext | null = null;
  let joining: Promise<void> | null = null;
  let closed = false;
  let gestureArmed = false;
  // The microphone: the chosen device id (null: the system default), and the known inputs.
  let inputId: string | null = null;
  let inputs: Array<NapVoiceInput> = [];
  // The page's own small state for the others in the call ({ captions: true }, ...).
  let meta: unknown = null;
  const canSelectInput = Boolean(
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.enumerateDevices === "function" &&
    typeof RTCRtpSender === "function" &&
    "replaceTrack" in RTCRtpSender.prototype,
  );

  function emit<E extends keyof Events>(event: E, value: Events[E]) {
    emitTo(listeners[event] as Set<(value: Events[E]) => void>, value);
  }
  function changed() {
    emit("change", api);
  }
  function fail(error: unknown) {
    emit("error", toNapError(error));
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
  function onDeviceChange() {
    void loadInputs();
  }
  if (canSelectInput) {
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    // Lists the microphones now if the person already allowed one on this site.
    void loadInputs();
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
  // The chosen microphone, or the default one when it is gone.
  async function openMic() {
    try {
      return await navigator.mediaDevices.getUserMedia(audioConstraints(inputId));
    } catch (error) {
      const errorName = (error as Error).name;
      if (!inputId || (errorName !== "OverconstrainedError" && errorName !== "NotFoundError")) {
        throw error;
      }
      inputId = null;
      return navigator.mediaDevices.getUserMedia(audioConstraints(null));
    }
  }
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
  async function switchInput(deviceId: string | null) {
    inputId = deviceId || null;
    if (status !== "joined") return changed();
    const previous = mic;
    const stream = await openMic();
    if (status !== "joined") {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    useMic(stream);
    const track = stream.getAudioTracks()[0];
    await Promise.all(
      [...links.values()].map((entry) => entry.sender && entry.sender.replaceTrack(track)),
    );
    if (previous) for (const old of previous.getTracks()) old.stop();
    void loadInputs();
    changed();
  }

  async function loadIceServers() {
    clearTimeout(iceTimer);
    try {
      const result = await napJson<{ iceServers: Array<RTCIceServer>; expiresAt: string | null }>(
        "rtc",
      );
      iceServers = result.iceServers;
      if (result.expiresAt) {
        // Ask again half an hour before the TURN credentials expire.
        const wait = Date.parse(result.expiresAt) - Date.now() - 30 * 60 * 1000;
        iceTimer = setTimeout(refreshIceServers, Math.max(wait, 60 * 1000));
      }
    } catch (error) {
      console.warn("Nap voice: no TURN servers, some networks will not connect", error);
      iceServers = STUN_ONLY;
    }
  }
  async function refreshIceServers() {
    await loadIceServers();
    for (const link of links.values()) {
      try {
        link.pc.setConfiguration({ iceServers });
      } catch {
        // Closed.
      }
    }
  }

  // Browsers only start sound after a click on the page. A page that joins without one (such
  // as on load, to stay in the call across pages) starts its sound at the first click or key.
  function resumeOnGesture() {
    if (gestureArmed) return;
    gestureArmed = true;
    const resume = () => {
      gestureArmed = false;
      removeEventListener("pointerdown", resume, true);
      removeEventListener("keydown", resume, true);
      if (audioContext && audioContext.state === "suspended") {
        audioContext.resume().catch(() => undefined);
      }
      for (const entry of links.values()) {
        if (entry.audio.srcObject && entry.audio.paused) entry.audio.play().catch(() => undefined);
      }
    };
    addEventListener("pointerdown", resume, true);
    addEventListener("keydown", resume, true);
  }

  // Speaking: the loudness of each stream, checked ten times a second.
  function watchLevel(key: string, stream: MediaStream) {
    if (!audioContext) return;
    try {
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
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
      return;
    }
    if (!levelTimer) levelTimer = setInterval(checkLevels, 100);
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
  function checkLevels() {
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
  }

  // One connection per other person in the call ("perfect negotiation": both sides may offer,
  // and the polite side gives way when offers cross).
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

  const offPresence = room.on("presence", sync);
  const offMessage = room.on("message", ({ from, data }) => {
    const signal = data as Signal | null;
    if (status !== "joined" || !signal || typeof signal.voice !== "string" || from.id === room.id) {
      return;
    }
    void onSignal(from.id, signal);
  });
  const offStatus = room.on("status", (next) => {
    if (next === "closed" && status !== "idle") stop();
    changed();
  });
  const offError = room.on("error", (error) => emit("error", error));

  async function join() {
    if (closed) throw new NapError("This voice call is closed", 400);
    if (status === "joined") return;
    if (joining) return joining;
    if (!navigator.mediaDevices || typeof RTCPeerConnection !== "function") {
      throw new NapError("Voice needs a browser with WebRTC, on https", 400);
    }
    status = "joining";
    changed();
    joining = (async () => {
      try {
        const AudioContextClass =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        // Made during the click, so the browser lets it run.
        if (AudioContextClass && !audioContext) audioContext = new AudioContextClass();
        const [stream] = await Promise.all([openMic(), loadIceServers()]);
        if (status !== "joining") {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        if (audioContext && audioContext.state === "suspended") {
          audioContext.resume().catch(() => undefined);
          // resume() is async: still suspended means the browser wants a click first.
          if ((audioContext.state as AudioContextState) !== "running") resumeOnGesture();
        }
        useMic(stream);
        status = "joined";
        void loadInputs();
        publishPresence();
        sync();
      } catch (error) {
        stop();
        const errorName = (error as Error | null)?.name;
        const napError =
          errorName === "NotAllowedError"
            ? new NapError("Microphone access was denied", 403)
            : errorName === "NotFoundError"
              ? new NapError("No microphone found", 404)
              : error;
        fail(napError);
        throw napError;
      } finally {
        joining = null;
      }
    })();
    return joining;
  }

  function stop() {
    const wasActive = status !== "idle";
    status = "idle";
    clearTimeout(iceTimer);
    for (const peerId of [...links.keys()]) unlink(peerId);
    unwatchLevel("self");
    clearInterval(levelTimer);
    levelTimer = undefined;
    if (mic) for (const track of mic.getTracks()) track.stop();
    mic = null;
    if (wasActive && room.status !== "closed") room.setPresence(null);
  }

  const api: NapVoiceCall = Object.freeze({
    name,
    /** "idle", "joining", or "joined". */
    get status() {
      return status;
    },
    get joined() {
      return status === "joined";
    },
    get muted() {
      return muted;
    },
    /** Whether this browser can switch microphones. */
    canSelectInput,
    /** Microphones, { deviceId, label }. Names appear once the person allowed the microphone. */
    get inputs() {
      return inputs;
    },
    /** The microphone in use (or chosen for the next join); null: the system default. */
    get input() {
      const track = mic && mic.getAudioTracks()[0];
      const settings = track && track.getSettings ? track.getSettings() : null;
      return (settings && settings.deviceId) || inputId;
    },
    /** Chooses a microphone (null: the default). In a call it switches without reconnecting. */
    setInput(deviceId: string | null) {
      return switchInput(deviceId).catch((error) => {
        fail(error);
        throw error;
      });
    },
    /** This page's own state for the others in the call, up to about 800 bytes. */
    setMeta(next: unknown) {
      meta = next === undefined ? null : next;
      publishPresence();
      changed();
    },
    /** Everyone in the call, this page included once joined (self: true), oldest first. */
    get participants() {
      return participants();
    },
    /** Asks for the microphone and joins. Call it from a click. */
    join,
    leave() {
      stop();
      changed();
    },
    setMuted(next: boolean) {
      muted = Boolean(next);
      if (mic) for (const track of mic.getAudioTracks()) track.enabled = !muted;
      publishPresence();
      changed();
    },
    /** "change" (with this object) on every join, leave, mute, speaking, or connection change. */
    on<E extends keyof Events>(event: E, listener: (value: Events[E]) => void) {
      const set = Object.hasOwn(listeners, event)
        ? (listeners[event] as Set<(value: Events[E]) => void>)
        : undefined;
      if (!set) throw new TypeError("Unknown voice event: " + String(event));
      set.add(listener);
      return () => void set.delete(listener);
    },
    /** Leaves the call and the channel. */
    close() {
      if (closed) return;
      closed = true;
      stop();
      offPresence();
      offMessage();
      offStatus();
      offError();
      voices.delete(name);
      if (canSelectInput) {
        navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
      }
      room.leave();
      if (audioContext) audioContext.close().catch(() => undefined);
      audioContext = null;
    },
  });
  voices.set(name, api);
  return api;
}
