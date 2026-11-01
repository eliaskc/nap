import test from "node:test";
import assert from "node:assert/strict";

// The voice engine (src/client/voice-engine.ts) against fake browser media: what a call opens,
// and that leaving, failing, or closing releases all of it.

class FakeNapError extends Error {
  name = "NapError";
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class FakeTrack {
  kind = "audio";
  enabled = true;
  stopped = false;
  constructor(deviceId) {
    this.deviceId = deviceId;
  }
  stop() {
    this.stopped = true;
  }
  addEventListener() {}
  getSettings() {
    return { deviceId: this.deviceId };
  }
}
class FakeStream {
  constructor(tracks) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

class FakePeerConnection {
  static all = [];
  closed = false;
  connectionState = "new";
  signalingState = "stable";
  senders = [];
  constructor(config) {
    this.config = config;
    FakePeerConnection.all.push(this);
  }
  addTrack(track) {
    const sender = {
      track,
      replaceTrack: async (next) => {
        sender.track = next;
      },
    };
    this.senders.push(sender);
    return sender;
  }
  close() {
    this.closed = true;
  }
  setConfiguration(config) {
    this.config = config;
  }
  restartIce() {}
  async setLocalDescription() {
    this.localDescription = { toJSON: () => ({ type: "offer", sdp: "x" }) };
  }
  async setRemoteDescription() {}
  async addIceCandidate() {}
}

class FakeAudioContext {
  static all = [];
  state = "running";
  constructor() {
    FakeAudioContext.all.push(this);
  }
  async close() {
    this.state = "closed";
  }
  async resume() {
    this.state = "running";
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createAnalyser() {
    return { fftSize: 0, getFloatTimeDomainData() {} };
  }
}

/** Fake browser media. `mic` decides what getUserMedia does for a device id. */
function browser({
  mic = (deviceId) => new FakeStream([new FakeTrack(deviceId ?? "default")]),
} = {}) {
  const opened = [];
  const elements = [];
  const navigator = {
    mediaDevices: {
      async getUserMedia(constraints) {
        const deviceId = constraints.audio.deviceId?.exact ?? null;
        const stream = await mic(deviceId);
        opened.push(stream);
        return stream;
      },
      async enumerateDevices() {
        return [
          { kind: "audioinput", deviceId: "default", label: "Built-in" },
          { kind: "audioinput", deviceId: "usb", label: "USB" },
        ];
      },
      addEventListener() {},
      removeEventListener() {},
    },
  };
  Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true });
  globalThis.window = { AudioContext: FakeAudioContext };
  globalThis.RTCPeerConnection = FakePeerConnection;
  globalThis.RTCRtpSender = class {
    replaceTrack() {}
  };
  globalThis.MediaStream = FakeStream;
  globalThis.document = {
    createElement() {
      const element = { srcObject: null, removed: false, remove: () => (element.removed = true) };
      elements.push(element);
      return element;
    },
    body: { appendChild() {} },
  };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  FakePeerConnection.all = [];
  FakeAudioContext.all = [];
  return { opened, elements };
}

/** A channel the test controls: peers and their presence. */
function fakeRoom(selfId = "me") {
  const listeners = {
    presence: new Set(),
    message: new Set(),
    status: new Set(),
    error: new Set(),
  };
  const room = {
    id: selfId,
    status: "open",
    peers: [{ id: selfId, email: "me@x", name: "me", joinedAt: 1, state: null, self: true }],
    presenceSent: [],
    sent: [],
    left: false,
    on(event, listener) {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
    send(data, options) {
      room.sent.push({ data, options });
      return true;
    },
    setPresence(state) {
      room.presenceSent.push(state);
      room.peers.find((p) => p.self).state = state;
    },
    leave() {
      room.left = true;
    },
    // Test side.
    addPeer(id, state) {
      room.peers.push({ id, email: `${id}@x`, name: id, joinedAt: 2, state, self: false });
      for (const listener of listeners.presence) listener(room.peers);
    },
    listenerCount: () => Object.values(listeners).reduce((n, set) => n + set.size, 0),
  };
  return room;
}

const { createVoiceEngine } = await import("../src/client/voice-engine.ts");

function engine(room, { initial = {}, ice } = {}) {
  const errors = [];
  let changes = 0;
  const voice = createVoiceEngine(
    "voice",
    {
      room,
      NapError: FakeNapError,
      loadIceServers:
        ice ?? (async () => ({ iceServers: [{ urls: "turn:t:3478" }], expiresAt: null })),
      changed: () => changes++,
      error: (error) => errors.push(error),
    },
    { muted: false, meta: null, inputId: null, ...initial },
  );
  return { voice, errors, changes: () => changes };
}

test("join opens the microphone, connects to the others, and leave releases it all", async () => {
  const { opened, elements } = browser();
  const room = fakeRoom();
  room.addPeer("other", { inCall: true });
  const { voice } = engine(room, { initial: { muted: true, meta: { captions: true } } });

  const joining = voice.join();
  assert.equal(voice.status, "joining");
  assert.equal(voice.join(), joining, "one join at a time");
  await joining;
  assert.equal(voice.status, "joined");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].tracks[0].enabled, false, "muted before joining stays muted");
  assert.deepEqual(room.presenceSent.at(-1), {
    inCall: true,
    muted: true,
    meta: { captions: true },
  });
  assert.equal(FakePeerConnection.all.length, 1);
  assert.deepEqual(FakePeerConnection.all[0].config.iceServers, [{ urls: "turn:t:3478" }]);
  assert.deepEqual(
    voice.participants.map((p) => [p.id, p.self, p.connection]),
    [
      ["me", true, null],
      ["other", false, "connecting"],
    ],
  );

  voice.leave();
  assert.equal(voice.status, "idle");
  assert.equal(opened[0].tracks[0].stopped, true, "the microphone stops");
  assert.equal(FakePeerConnection.all[0].closed, true, "connections close");
  assert.equal(elements[0].removed, true, "audio elements go");
  assert.equal(room.presenceSent.at(-1), null, "out of the call");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(FakeAudioContext.all[0].state, "closed", "the call's audio context closes");
});

test("a denied or missing microphone rejects with 403 or 404, and leaves nothing open", async () => {
  for (const [name, status] of [
    ["NotAllowedError", 403],
    ["NotFoundError", 404],
  ]) {
    browser({
      mic: () => {
        throw Object.assign(new Error(name), { name });
      },
    });
    const room = fakeRoom();
    const { voice, errors } = engine(room);
    await assert.rejects(voice.join(), { name: "NapError", status });
    assert.equal(errors[0].status, status, "and reports it as an error event");
    assert.equal(voice.status, "idle");
    assert.equal(room.presenceSent.length, 0, "never in the call");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(FakeAudioContext.all[0].state, "closed");
  }
});

test("a chosen microphone that is gone falls back to the default one", async () => {
  const { opened } = browser({
    mic: (deviceId) => {
      if (deviceId === "gone")
        throw Object.assign(new Error("x"), { name: "OverconstrainedError" });
      return new FakeStream([new FakeTrack(deviceId ?? "default")]);
    },
  });
  const { voice } = engine(fakeRoom(), { initial: { inputId: "gone" } });
  await voice.join();
  assert.equal(opened.length, 1);
  assert.equal(voice.input, "default");
  voice.close();
});

test("leaving while the microphone opens releases it once it arrives", async () => {
  let open;
  const { opened } = browser({
    mic: (deviceId) =>
      new Promise((resolve) => {
        open = () => resolve(new FakeStream([new FakeTrack(deviceId ?? "default")]));
      }),
  });
  const room = fakeRoom();
  const { voice } = engine(room);
  const joining = voice.join();
  await new Promise((resolve) => setTimeout(resolve, 0));
  voice.leave();
  assert.equal(voice.status, "idle");
  open();
  await joining;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(opened[0].tracks[0].stopped, true, "stopped although it arrived late");
  assert.equal(voice.status, "idle");
  assert.equal(room.presenceSent.length, 0);

  // A new join afterwards works, and the old call's cleanup does not touch it.
  const again = voice.join();
  await new Promise((resolve) => setTimeout(resolve, 0));
  open();
  await again;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(voice.status, "joined");
  assert.equal(opened[1].tracks[0].stopped, false);
  voice.close();
});

test("switching microphones replaces the track without reconnecting, then stops the old one", async () => {
  const { opened } = browser();
  const room = fakeRoom();
  room.addPeer("other", { inCall: true });
  const { voice } = engine(room);
  await voice.join();
  const pc = FakePeerConnection.all[0];
  await voice.setInput("usb");
  assert.equal(opened.length, 2);
  assert.equal(opened[0].tracks[0].stopped, true);
  assert.equal(opened[1].tracks[0].stopped, false);
  assert.equal(pc.senders[0].track, opened[1].tracks[0]);
  assert.equal(pc.closed, false);
  assert.equal(voice.input, "usb");
  assert.equal(FakePeerConnection.all.length, 1, "no new connection");
  voice.close();
});

test("TURN servers: STUN only when Nap fails, and the call still joins", async () => {
  browser();
  const { voice } = engine(fakeRoom(), {
    ice: async () => {
      throw new Error("offline");
    },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await voice.join();
  } finally {
    console.warn = warn;
  }
  assert.equal(voice.status, "joined");
  voice.close();
});

test("close leaves the call and the channel, and stops listening", async () => {
  const { opened } = browser();
  const room = fakeRoom();
  const { voice } = engine(room);
  assert.equal(room.listenerCount(), 4);
  await voice.join();
  voice.close();
  assert.equal(opened[0].tracks[0].stopped, true);
  assert.equal(room.left, true);
  assert.equal(room.listenerCount(), 0);
  await assert.rejects(voice.join(), { status: 400 });
});
