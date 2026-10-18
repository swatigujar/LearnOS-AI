const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function renderTutor({ conceptIndex = 1, canConfirm = true, completed = false,
  paused = false, busy = false, loading = false, liveStatus = "idle", moduleReady = false,
  error = "", liveError = "", savedBusy = false, canStop = false, stopping = false,
  stopped = false, messageCount = 1 } = {}) {
  const calls = [];
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: {
      useEffect() {},
      useRef: (current) => ({ current }),
      useState: (value) => [value, () => {}],
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "lucide-react": {},
    "@/lib/auth-context": { useAuth: () => ({ user: null }) },
    "@/lib/tutor-live": { useLiveTutor: () => ({
      status: liveStatus, disconnect: async () => {}, partialTranscript: "", error: liveError,
    }) },
  };
  const source = ts.transpileModule(readFileSync(path.join(__dirname, "../components/ai-tutor.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const context = {
    exports: {},
    require: (name) => {
      assert.ok(name in modules, `Unexpected dependency: ${name}`);
      return modules[name];
    },
  };
  vm.runInNewContext(source, context);
  const state = {
    learner_name: "Learner",
    active_topic_id: "topic-1",
    progress_epoch: 0,
    paused,
    busy: savedBusy,
    topic_status: { "topic-1": completed ? "completed" : "in_progress" },
    can_confirm: canConfirm,
    conversation: {
      concepts: ["Values", "Variables"], concept_index: conceptIndex,
      messages: Array.from({ length: messageCount }, (_, index) => ({
        id: `message-${index}`, role: "assistant", text: `Explain a variable ${index}.`, reply: null,
      })),
    },
  };
  const tree = context.exports.AiTutor({
    courseId: "course-1",
    controller: {
      state, loading, busy, error,
      messages: state.conversation.messages, canStop, stopping, stopped,
      stopResponse: async () => { calls.push(["stop"]); },
      perform: async (...args) => { calls.push(args); return true; },
      reload: async () => { calls.push(["reload"]); },
    },
    lesson: { topic_id: "topic-1", title: "Basics", moduleTitle: "Python", estimated_minutes: 10 },
    nextTopicId: "topic-2",
    moduleReady,
  });
  return { tree, calls };
}

function text(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return text(node.props?.children);
}

function buttons(node, inDetails = false) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((child) => buttons(child, inDetails));
  const hidden = inDetails || node.type === "details";
  return [
    ...(node.type === "button" ? [{ ...node, inDetails: hidden }] : []),
    ...buttons(node.props?.children, hidden),
  ];
}

function button(tree, label) {
  return buttons(tree).find((node) => text(node) === label);
}

test("final concept exposes Mark as complete outside collapsed controls and sends confirmation", async () => {
  const { tree, calls } = renderTutor();
  const complete = button(tree, "Mark as complete");
  assert.ok(complete);
  assert.equal(complete.inDetails, false);
  assert.equal(complete.props.disabled, false);
  complete.props.onClick();
  assert.deepEqual(calls, [["confirm", undefined]]);
  assert.match(text(tree), /queue its notes/);
});

test("earlier concepts expose continuation rather than prematurely completing a topic", () => {
  const { tree } = renderTutor({ conceptIndex: 0 });
  assert.equal(button(tree, "I understand · Continue").inDetails, false);
  assert.equal(button(tree, "Mark as complete"), undefined);
});

test("completion remains visible but disabled until a learner response permits confirmation", () => {
  const { tree } = renderTutor({ canConfirm: false });
  const complete = button(tree, "Mark as complete");
  assert.equal(complete.inDetails, false);
  assert.equal(complete.props.disabled, true);
});

for (const options of [{ paused: true }, { busy: true }, { loading: true }, { liveStatus: "connected" }]) {
  test(`completion preserves action restrictions: ${JSON.stringify(options)}`, () => {
    const { tree } = renderTutor(options);
    assert.equal(button(tree, "Mark as complete").props.disabled, true);
  });
}

test("completed topics show a visible next lesson without offering duplicate completion", () => {
  const { tree, calls } = renderTutor({ completed: true });
  assert.equal(button(tree, "Mark as complete"), undefined);
  const next = button(tree, "Next lesson");
  assert.equal(next.inDetails, false);
  next.props.onClick();
  assert.deepEqual(calls, [["select", "topic-2"]]);
});

test("module confirmation remains visible and precedes next lesson", () => {
  const { tree, calls } = renderTutor({ completed: true, moduleReady: true });
  const confirm = button(tree, "Confirm module completion");
  assert.equal(confirm.inDetails, false);
  assert.equal(button(tree, "Next lesson"), undefined);
  confirm.props.onClick();
  assert.deepEqual(calls, [["confirm_module", undefined]]);
});

test("tutor failure shows a calm recovery notice without contradictory progress messaging", () => {
  const { tree, calls } = renderTutor({
    error: "We're having a little trouble connecting to your tutor.",
    busy: true, savedBusy: true,
  });
  assert.match(text(tree), /Let's get your lesson back on track/);
  assert.doesNotMatch(text(tree), /Your tutor is working on this step/);
  const recover = button(tree, "Check saved lesson");
  assert.equal(recover.inDetails, false);
  assert.equal(recover.props.disabled, false);
  recover.props.onClick();
  assert.deepEqual(calls, [["reload"]]);
});

test("lesson recovery is disabled while a request is still running", () => {
  const { tree } = renderTutor({ error: "Please try again in a moment.", busy: true });
  assert.equal(button(tree, "Check saved lesson").props.disabled, true);
});

test("voice failure preserves helpful guidance and offers chat", () => {
  const { tree } = renderTutor({ liveError: "Microphone access is off. Allow it in your browser settings." });
  assert.match(text(tree), /Let's reconnect with your tutor/);
  assert.match(text(tree), /Microphone access is off/);
  assert.match(text(tree), /switch to chat/);
});

test("all messages render directly in the scrollable conversation rather than collapsed history", () => {
  const { tree } = renderTutor({ messageCount: 55 });
  function collect(node) {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(collect);
    return [node, ...collect(node.props?.children)];
  }
  const nodes = collect(tree);
  const log = nodes.find((node) => node.props?.role === "log");
  assert.match(log.props.className, /overflow-y-auto/);
  assert.equal(collect(log).filter((node) => typeof node.type === "function" && node.props?.message).length, 55);
  assert.equal(collect(log).some((node) => node.type === "details"), false);
});

test("a slow chat response exposes Stop instead of the send button", () => {
  const { tree, calls } = renderTutor({ busy: true, canStop: true });
  const stop = button(tree, "Stop response");
  assert.ok(stop);
  assert.equal(stop.props.disabled, false);
  stop.props.onClick();
  assert.deepEqual(calls, [["stop"]]);
  assert.equal(button(tree, "Send"), undefined);
});

test("stopping cannot be submitted twice while cancellation is being saved", () => {
  const { tree } = renderTutor({ busy: true, canStop: true, stopping: true });
  assert.equal(button(tree, "Stopping...").props.disabled, true);
});

test("a stopped chat can continue without restarting course progress", () => {
  const { tree, calls } = renderTutor({ stopped: true });
  assert.match(text(tree), /Response stopped/);
  button(tree, "Continue chat").props.onClick();
  assert.deepEqual(calls, [["message", undefined, "Please continue the current concept."]]);
});
