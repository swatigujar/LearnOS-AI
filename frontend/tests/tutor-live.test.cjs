const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { randomUUID } = require("node:crypto");

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function loadHook({ responseStatus = 429, microphone, fetchGate, fetchFailure } = {}) {
  const effects = [];
  const requests = [];
  const errors = [];
  const timers = new Set();
  const states = [];
  const sessions = [];
  const transcriptRequests = [];
  const trackListeners = {};
  let microphoneCalls = 0;
  let socketCalls = 0;
  let stoppedTracks = 0;
  const mockTrack = { addEventListener(name, callback) { trackListeners[name] = callback; }, stop() { stoppedTracks += 1; } };
  const stream = { getTracks: () => [mockTrack], getAudioTracks: () => [mockTrack] };
  const node = () => ({ connect() {}, disconnect() {} });
  class AudioContext {
    state = "running";
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return node(); }
    createGain() { return { ...node(), gain: { value: 0 } }; }
    async resume() {}
    async close() { this.state = "closed"; }
  }
  const react = {
    useRef: (value) => ({ current: value }),
    useCallback: (callback) => callback,
    useEffect: (effect) => { effects.push(effect); },
    useState: (initial) => {
      const index = states.length;
      states.push(initial);
      return [initial, (value) => {
        states[index] = value;
        if (index === 7 && value) errors.push(value);
      }];
    },
  };
  const modules = {
    react,
    "@/lib/auth-context": { useAuth: () => ({ user: { getIdToken: async () => "firebase-id-token" } }) },
    "@/lib/tutor": {
      friendlyTutorError: (_status, detail) => detail,
      friendlyTutorFailure: (failure) => failure.message,
    },
    "@google/genai": {
      Modality: { AUDIO: "AUDIO" },
      GoogleGenAI: class {
        live = { connect: async (options) => {
          socketCalls += 1;
          const session = { callbacks: options.callbacks, closeCalls: 0, sent: [],
            close() { this.closeCalls += 1; }, sendRealtimeInput(message) { this.sent.push(message); } };
          sessions.push(session);
          return session;
        } };
      },
    },
  };
  const source = ts.transpileModule(readFileSync(path.join(__dirname, "../lib/tutor-live.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = {
    exports: {},
    require: (name) => {
      assert.ok(name in modules, `Unexpected dependency: ${name}`);
      return modules[name];
    },
    navigator: { mediaDevices: { getUserMedia: async () => {
      microphoneCalls += 1;
      return microphone ? microphone.promise : stream;
    } } },
    AudioContext,
    AudioWorkletNode: class { port = {}; connect() {} disconnect() {} },
    Blob,
    URL,
    crypto: { randomUUID },
    AbortSignal,
    setTimeout: (callback, duration) => {
      const timer = setTimeout(callback, duration);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => { clearTimeout(timer); timers.delete(timer); },
    window: {
      setTimeout: (callback, duration) => {
        const timer = setTimeout(callback, duration);
        timers.add(timer);
        return timer;
      },
      clearTimeout: (timer) => { clearTimeout(timer); timers.delete(timer); },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (fetchFailure) throw fetchFailure;
      if (fetchGate) await fetchGate.promise;
      if (url === "/api/tutor/live/transcript") transcriptRequests.push(JSON.parse(options.body));
      return {
        ok: responseStatus === 200,
        status: responseStatus,
        json: async () => responseStatus === 200
          ? { accessToken: "one-use-token", model: "test-model", config: {} }
          : { detail: "The configured monthly Gemini estimated-cost limit has been reached." },
      };
    },
  };
  vm.runInNewContext(source, context);
  const hook = context.exports.useLiveTutor("course-123", "topic-1", 0, () => {});
  for (const effect of effects) effect();
  return {
    hook, requests, errors, states,
    sessions, transcriptRequests,
    endMicrophone: () => trackListeners.ended?.(),
    microphoneCalls: () => microphoneCalls,
    stoppedTracks: () => stoppedTracks,
    socketCalls: () => socketCalls,
    cleanup: () => { for (const timer of timers) clearTimeout(timer); },
  };
}

test("a rejected session is requested once and only explicit Retry creates another request", async (context) => {
  const client = loadHook();
  context.after(client.cleanup);
  assert.equal(await client.hook.connect(), false);
  await new Promise(setImmediate);
  assert.equal(client.requests.length, 1);
  assert.equal(client.socketCalls(), 0);
  assert.match(client.errors[0], /monthly/);
  assert.equal(client.states[0], "idle");
  assert.equal(await client.hook.connect(), false);
  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[0].options.headers.Authorization, "Bearer firebase-id-token");
});

test("rapid Start clicks cannot create duplicate sessions before a React rerender", async (context) => {
  const microphone = deferred();
  const client = loadHook({ microphone, responseStatus: 200 });
  context.after(client.cleanup);
  const first = client.hook.connect();
  assert.equal(await client.hook.connect(), false);
  assert.equal(client.microphoneCalls(), 1);
  const microphoneTrack = { addEventListener() {}, stop() {} };
  microphone.resolve({ getTracks: () => [microphoneTrack], getAudioTracks: () => [microphoneTrack] });
  assert.equal(await first, true);
  assert.equal(client.requests.length, 1);
  assert.equal(client.socketCalls(), 1);
  assert.equal(await client.hook.connect(), false);
  assert.equal(client.requests.length, 1);
  await client.hook.disconnect(false);
});

test("cancelling an in-flight token request blocks a new request until it settles", async (context) => {
  const fetchGate = deferred();
  const client = loadHook({ fetchGate, responseStatus: 200 });
  context.after(client.cleanup);
  const first = client.hook.connect();
  await new Promise(setImmediate);
  assert.equal(client.requests.length, 1);
  await client.hook.disconnect(false);
  assert.equal(await client.hook.connect(), false);
  assert.equal(client.requests.length, 1);
  fetchGate.resolve();
  assert.equal(await first, false);
  assert.equal(client.socketCalls(), 0);
  assert.equal(client.requests.length, 1);
});

test("network failure is not retried automatically", async (context) => {
  const client = loadHook({ fetchFailure: new Error("Network unavailable") });
  context.after(client.cleanup);
  assert.equal(await client.hook.connect(), false);
  await new Promise(setImmediate);
  assert.equal(client.microphoneCalls(), 1);
  assert.equal(client.requests.length, 1);
  assert.equal(client.socketCalls(), 0);
  assert.match(client.errors[0], /Network unavailable/);
});

test("a completed audio turn leaves Live Voice active until explicit Stop and saves both transcript turns", async (context) => {
  const client = loadHook({ responseStatus: 200 });
  context.after(client.cleanup);
  assert.equal(await client.hook.connect(), true);
  const session = client.sessions[0];
  session.callbacks.onmessage({ serverContent: {
    inputTranscription: { text: "Explain the example." },
    outputTranscription: { text: "Let us walk through it." },
    turnComplete: true,
  } });

  await new Promise((resolve) => setTimeout(resolve, 4_100));
  assert.equal(client.states[0], "connected");
  assert.equal(session.closeCalls, 0);
  assert.equal(client.stoppedTracks(), 0);
  assert.equal(client.transcriptRequests.length, 1);
  assert.deepEqual(client.transcriptRequests[0].turns, [
    { role: "user", text: "Explain the example." },
    { role: "assistant", text: "Let us walk through it." },
  ]);

  await client.hook.disconnect();
  assert.equal(client.states[0], "idle");
  assert.equal(session.closeCalls, 1);
  assert.equal(client.stoppedTracks(), 1);
});

test("an unexpected Live Voice socket close is reported as a terminal connection error", async (context) => {
  const client = loadHook({ responseStatus: 200 });
  context.after(client.cleanup);
  assert.equal(await client.hook.connect(), true);
  client.sessions[0].callbacks.onclose();
  await new Promise(setImmediate);
  assert.equal(client.states[0], "idle");
  assert.match(client.errors.at(-1), /connection ended/i);
  assert.equal(client.stoppedTracks(), 1);
});

test("a terminal Live Voice error stops microphone capture without retrying", async (context) => {
  const client = loadHook({ responseStatus: 200 });
  context.after(client.cleanup);
  assert.equal(await client.hook.connect(), true);
  client.sessions[0].callbacks.onerror({ message: "Live transport failed." });
  await new Promise(setImmediate);

  assert.equal(client.states[0], "idle");
  assert.match(client.errors.at(-1), /Live transport failed/);
  assert.equal(client.sessions[0].closeCalls, 1);
  assert.equal(client.stoppedTracks(), 1);
  assert.equal(client.requests.length, 1);
  assert.equal(client.socketCalls(), 1);
});

test("explicit Stop does not persist an unfinished exchange as a completed transcript", async (context) => {
  const client = loadHook({ responseStatus: 200 });
  context.after(client.cleanup);
  assert.equal(await client.hook.connect(), true);
  client.sessions[0].callbacks.onmessage({ serverContent: {
    inputTranscription: { text: "An unfinished question" },
    outputTranscription: { text: "An incomplete answer" },
  } });

  await client.hook.disconnect();

  assert.equal(client.states[0], "idle");
  assert.equal(client.transcriptRequests.length, 0);
  assert.equal(client.sessions[0].closeCalls, 1);
  assert.equal(client.stoppedTracks(), 1);
});

test("microphone track termination ends the session with a clear error", async (context) => {
  const client = loadHook({ responseStatus: 200 });
  context.after(client.cleanup);
  assert.equal(await client.hook.connect(), true);
  client.endMicrophone();
  await new Promise(setImmediate);

  assert.equal(client.states[0], "idle");
  assert.match(client.errors.at(-1), /microphone input ended/i);
  assert.equal(client.sessions[0].closeCalls, 1);
  assert.equal(client.stoppedTracks(), 1);
});
