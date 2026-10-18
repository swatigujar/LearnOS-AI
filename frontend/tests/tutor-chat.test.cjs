const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { randomUUID } = require("node:crypto");

function loadModule(file, modules, globals = {}) {
  const context = { exports: {}, require: (name) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, ...globals };
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(__dirname, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}

const { mergeTutorMessages } = loadModule("../lib/tutor-history.ts", {});
const message = (id, text = id) => ({ id, role: "user", text, reply: null, channel: "chat" });

test("history merges with the working context without duplicate or dropped messages", () => {
  const history = Array.from({ length: 60 }, (_, i) => message(String(i)));
  const recent = Array.from({ length: 20 }, (_, i) => message(String(i + 50)));
  const merged = mergeTutorMessages(history, recent);
  assert.equal(merged.length, 70);
  assert.equal(new Set(merged.map((item) => item.id)).size, 70);
  assert.equal(merged[0].id, "0");
  assert.equal(merged.at(-1).id, "69");
});

test("identical text from separate operations is not discarded", () => {
  const merged = mergeTutorMessages([message("one", "Hi")], [message("two", "Hi")]);
  assert.equal(merged.length, 2);
});

test("a delayed history page overlapping the middle of live chat does not reorder or duplicate messages", () => {
  const recent = Array.from({ length: 90 }, (_, i) => message(String(i)));
  const merged = mergeTutorMessages(recent.slice(30, 80), recent);
  assert.equal(merged.length, 90);
  assert.deepEqual(Array.from(merged, (item) => item.id), recent.map((item) => item.id));
});

test("legacy history text is reconciled with a structured recent reply", () => {
  const reply = {
    intent: "teach", concept_title: "Values", explanation: "A value is data.",
    example: "42", check_question: "What is a value?", visuals: [],
  };
  const history = [{ id: "old", role: "assistant", text: "Values\nA value is data.\nExample: 42\nQuestion asked: What is a value?", reply: null, channel: "chat" }];
  const recent = [{ role: "assistant", text: "", reply, channel: "chat" }];
  const merged = mergeTutorMessages(history, recent);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].reply, reply);
});

const savedState = (overrides = {}) => ({
  learner_name: "Learner", active_topic_id: "module-1-topic-1", progress_epoch: 0,
  syllabus_version: 1, revision: 0, paused: false, busy: false,
  topic_status: {}, module_status: {}, can_confirm: false,
  conversation: { concepts: ["Values"], concept_index: 0, messages: [] },
  ...overrides,
});

function hookHarness(fetch) {
  const slots = [];
  const pendingEffects = [];
  let index = 0;
  const react = {
    useState(initial) {
      const key = index++;
      if (!(key in slots)) slots[key] = initial;
      return [slots[key], (value) => { slots[key] = typeof value === "function" ? value(slots[key]) : value; }];
    },
    useRef(initial) {
      const key = index++;
      if (!(key in slots)) slots[key] = { current: initial };
      return slots[key];
    },
    useEffect(effect, deps) {
      const key = index++;
      const previous = slots[key];
      if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
        previous?.cleanup?.();
        slots[key] = { deps };
        pendingEffects.push(() => { slots[key].cleanup = effect(); });
      }
    },
  };
  const user = { getIdToken: async () => "test-token" };
  const { useTutor } = loadModule("../lib/tutor.ts", {
    react, "@/lib/auth-context": { useAuth: () => ({ user }) },
    "@/lib/tutor-history": { mergeTutorMessages },
  }, { fetch, AbortController, AbortSignal, crypto: { randomUUID }, Error });
  return () => {
    index = 0;
    const result = useTutor("course-1", true);
    while (pendingEffects.length) pendingEffects.shift()();
    return result;
  };
}

const respond = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("Stop aborts a slow request, persists cancellation, and allows a fresh message", async () => {
  const requests = [];
  let actionCount = 0;
  const render = hookHarness(async (url, options) => {
    requests.push({ url, options });
    if (url.includes("view=history")) return respond({ messages: [], next_cursor: null });
    if (!options.body) return respond(savedState());
    if (url.includes("action=cancel")) return respond(savedState({ revision: 2 }));
    actionCount += 1;
    if (actionCount === 1) return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")));
    });
    return respond(savedState({ revision: 3 }));
  });
  render();
  await flush();
  let tutor = render();
  await flush();
  const pending = tutor.perform("message", undefined, "Explain values");
  await flush();
  tutor = render();
  assert.equal(tutor.canStop, true);
  const original = requests.find((item) => item.options.body && !item.url.includes("cancel"));
  const operationId = JSON.parse(original.options.body).operationId;
  await tutor.stopResponse();
  assert.equal(await pending, false);
  assert.equal(original.options.signal.aborted, true);
  const cancel = requests.find((item) => item.url.includes("action=cancel"));
  assert.equal(JSON.parse(cancel.options.body).operationId, operationId);
  tutor = render();
  assert.equal(tutor.stopped, true);
  assert.equal(tutor.busy, false);
  assert.equal(tutor.error, "");
  assert.equal(await tutor.perform("message", undefined, "Continue"), true);
  assert.equal(render().state.revision, 3);
});

test("failed cancellation stays recoverable and does not unlock unsafe duplicate requests", async () => {
  const render = hookHarness(async (url, options) => {
    if (url.includes("view=history")) return respond({ messages: [], next_cursor: null });
    if (url.includes("action=cancel")) return respond({ detail: "Unavailable" }, 503);
    return respond(savedState({ busy: true, pending_operation_id: "a".repeat(32) }));
  });
  render();
  await flush();
  let tutor = render();
  await flush();
  await tutor.stopResponse();
  tutor = render();
  assert.equal(tutor.busy, true);
  assert.equal(tutor.canStop, true);
  assert.ok(tutor.error);
  assert.equal(await tutor.perform("message", undefined, "Continue"), false);
});

test("a cancelled response arriving late cannot overwrite a newer chat response", async () => {
  let finishOldResponse;
  let actions = 0;
  const render = hookHarness(async (url, options) => {
    if (url.includes("view=history")) return respond({ messages: [], next_cursor: null });
    if (!options.body) return respond(savedState());
    if (url.includes("action=cancel")) return respond(savedState({ revision: 2 }));
    actions += 1;
    if (actions === 1) return new Promise((resolve) => { finishOldResponse = resolve; });
    return respond(savedState({ revision: 4 }));
  });
  render();
  await flush();
  let tutor = render();
  await flush();
  const old = tutor.perform("message", undefined, "First request");
  await flush();
  await tutor.stopResponse();
  tutor = render();
  assert.equal(await tutor.perform("message", undefined, "New request"), true);
  finishOldResponse(respond(savedState({ revision: 1 })));
  assert.equal(await old, false);
  tutor = render();
  assert.equal(tutor.state.revision, 4);
  assert.equal(tutor.error, "");
  assert.equal(tutor.busy, false);
});

test("messages remain visible after successive updates exceed the 20-message working context", async () => {
  const render = hookHarness(async (url) => url.includes("view=history")
    ? respond({ messages: [], next_cursor: null }) : respond(savedState()));
  render();
  await flush();
  render();
  await flush();
  let tutor = render();
  const all = Array.from({ length: 70 }, (_, i) => message(String(i)));
  for (let count = 1; count <= all.length; count += 1) {
    tutor.acceptSavedState(savedState({
      revision: count, conversation: { concepts: [], concept_index: 0, messages: all.slice(Math.max(0, count - 20), count) },
    }));
    tutor = render();
  }
  assert.equal(tutor.messages.length, 70);
});
