/* eslint @typescript-eslint/no-require-imports: off */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

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
  let microphoneCalls = 0;
  let socketCalls = 0;
  const stream = { getTracks: () => [{ stop() {} }] };
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
        live = { connect: async () => {
          socketCalls += 1;
          return { close() {}, sendRealtimeInput() {} };
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
    AbortSignal,
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
    microphoneCalls: () => microphoneCalls,
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
  microphone.resolve({ getTracks: () => [{ stop() {} }] });
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
