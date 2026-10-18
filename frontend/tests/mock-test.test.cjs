const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { randomUUID } = require("node:crypto");

function load(file, modules = {}, globals = {}) {
  const context = { exports: {}, require: (name) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, ...globals };
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(__dirname, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, context);
  return context.exports;
}

const { summarizeMockTopics, friendlyMockError } = load("../lib/mock-test.ts");
const result = (overrides = {}) => ({
  attemptId: "attempt-1", courseId: "course-1", courseTitle: "Python",
  topicId: "module-1-topic-1", topicTitle: "Variables", moduleTitle: "Basics", syllabusVersion: 1,
  total: 10, correct: 8, incorrect: 1, unanswered: 1, percentage: 80,
  completedAt: "2026-10-18T09:00:00Z", questions: [], ...overrides,
});

test("topic-wise marks include repeated attempts and separate syllabus versions", () => {
  const summary = summarizeMockTopics([
    result({ attemptId: "latest", correct: 9, percentage: 90 }),
    result({ attemptId: "older", correct: 5, percentage: 50 }),
    result({ attemptId: "other-version", syllabusVersion: 2 }),
    result({ attemptId: "other-topic", topicId: "module-1-topic-2", topicTitle: "Functions" }),
  ]);
  assert.equal(summary.length, 3);
  assert.equal(summary[0].attempts, 2);
  assert.equal(summary[0].correct, 14);
  assert.equal(summary[0].total, 20);
  assert.equal(summary[0].percentage, 70);
  assert.equal(summary[0].latestPercentage, 90);
  assert.equal(summary[0].bestPercentage, 90);
  assert.equal(summarizeMockTopics([]).length, 0);
});

test("mock failures offer friendly recovery rather than exposing provider errors", () => {
  for (const status of [401, 404, 409, 422, 429, 500, 503, 504]) {
    assert.ok(friendlyMockError(status).length > 15);
    assert.doesNotMatch(friendlyMockError(status), /traceback|api key|exception/i);
  }
});

function text(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node !== "object") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return text(node.props?.children);
}
function nodes(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
function button(tree, label) {
  const found = nodes(tree).find((node) => node.type === "button" && text(node) === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
}

function pageHarness({ submitFailure = false, pendingGeneration = false } = {}) {
  const slots = [];
  const effects = [];
  const requests = [];
  let position = 0;
  let attemptNumber = 0;
  const react = {
    useState(initial) {
      const key = position++;
      if (!(key in slots)) slots[key] = initial;
      return [slots[key], (value) => { slots[key] = typeof value === "function" ? value(slots[key]) : value; }];
    },
    useRef(initial) {
      const key = position++;
      if (!(key in slots)) slots[key] = { current: initial };
      return slots[key];
    },
    useEffect(effect, deps) {
      const key = position++;
      const previous = slots[key];
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.();
        slots[key] = { deps };
        effects.push(() => { slots[key].cleanup = effect(); });
      }
    },
    useMemo(callback) { return callback(); },
    useCallback(callback) { return callback; },
  };
  const user = { uid: "user-1", getIdToken: async () => "id-token" };
  const routeParams = { goalId: "course-1" };
  const router = { replace() {} };
  const jsx = (type, props) => ({ type, props });
  const page = load("../app/dashboard/courses/[goalId]/mock-test/page.tsx", {
    react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "next/link": { default: "a" },
    "next/navigation": { useParams: () => routeParams, useRouter: () => router },
    "firebase/firestore": {
      doc: (_db, ...parts) => parts.join("/"),
      onSnapshot: (reference, next) => {
        next({ exists: () => true, data: () => reference.includes("/syllabus/")
          ? { modules: [{ module_id: "module-1", title: "Basics", topics: [
            { topic_id: "module-1-topic-1", title: "Variables", description: "Learn values." },
          ] }] }
          : { course_name: "Python", syllabusStatus: "ready", syllabusVersion: 1 } });
        return () => {};
      },
    },
    "@/lib/auth-context": { useAuth: () => ({ user, loading: false }) },
    "@/lib/firebase": { db: {} },
    "@/components/ui/select": { Select: "select" },
    "@/lib/mock-test": {
      summarizeMockTopics,
      requestMock: async (_token, query, body) => {
        requests.push({ query, body });
        if (query.includes("action=attempts")) return { attempts: [] };
        if (body?.action === "submit") {
          if (submitFailure) throw new Error("Database unavailable");
          return result({ attemptId: body.attemptId });
        }
        if (body?.action === "start") {
          attemptNumber += 1;
          if (pendingGeneration) return { status: "pending", attemptId: body.attemptId, questions: [] };
        }
        return { status: "ready", attemptId: body?.attemptId, questions: Array.from({ length: 10 }, (_, index) => ({
          questionId: `q${index + 1}`, prompt: `Fresh ${attemptNumber} question ${index + 1}?`, options: ["A", "B", "C", "D"],
        })) };
      },
    },
  }, { crypto: { randomUUID }, window: { setTimeout, clearTimeout } }).default;
  return { requests, render() {
    position = 0;
    const tree = page();
    while (effects.length) effects.shift()();
    return tree;
  } };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test("every explicit new test generates fresh questions and submit carries its exact attempt ID", async () => {
  const harness = pageHarness();
  harness.render();
  await flush();
  let tree = harness.render();
  assert.equal(harness.requests.filter((request) => request.body?.action === "start").length, 0);
  button(tree, "Start new test").props.onClick();
  await flush();
  tree = harness.render();
  assert.match(text(tree), /Fresh 1 question 1/);
  const radio = nodes(tree).find((node) => node.type === "input");
  radio.props.onChange();
  tree = harness.render();
  for (let index = 0; index < 9; index += 1) {
    button(tree, "Next").props.onClick();
    tree = harness.render();
  }
  button(tree, "Submit and save result").props.onClick();
  await flush();
  tree = harness.render();
  const first = harness.requests.find((request) => request.body?.action === "start").body;
  const submit = harness.requests.find((request) => request.body?.action === "submit").body;
  assert.equal(submit.attemptId, first.attemptId);
  assert.equal(submit.answers.q1, 0);
  assert.match(text(tree), /8\/10 marks/);
  button(tree, "Generate new test").props.onClick();
  await flush();
  tree = harness.render();
  const starts = harness.requests.filter((request) => request.body?.action === "start");
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].body.attemptId, starts[1].body.attemptId);
  assert.match(text(tree), /Fresh 2 question 1/);
});

test("failed result save retains selections and allows retrying the same attempt", async () => {
  const harness = pageHarness({ submitFailure: true });
  harness.render();
  await flush();
  let tree = harness.render();
  button(tree, "Start new test").props.onClick();
  await flush();
  tree = harness.render();
  nodes(tree).find((node) => node.type === "input").props.onChange();
  tree = harness.render();
  for (let index = 0; index < 9; index += 1) { button(tree, "Next").props.onClick(); tree = harness.render(); }
  button(tree, "Submit and save result").props.onClick();
  await flush();
  tree = harness.render();
  assert.match(text(tree), /couldn't confirm that your result was saved/);
  assert.match(text(tree), /1 answered/);
  button(tree, "Submit and save result").props.onClick();
  await flush();
  const submits = harness.requests.filter((request) => request.body?.action === "submit");
  assert.equal(submits.length, 2);
  assert.equal(submits[0].body.attemptId, submits[1].body.attemptId);
});

test("checking pending preparation resumes the same saved attempt without another AI start", async () => {
  const harness = pageHarness({ pendingGeneration: true });
  harness.render();
  await flush();
  let tree = harness.render();
  button(tree, "Start new test").props.onClick();
  await flush();
  tree = harness.render();
  assert.match(text(tree), /still being prepared/);
  assert.doesNotMatch(text(tree), /Fresh 1 question/);
  button(tree, "Check saved test").props.onClick();
  await flush();
  tree = harness.render();
  const starts = harness.requests.filter((request) => request.body?.action === "start");
  assert.equal(starts.length, 1);
  const check = harness.requests.find((request) => request.query.includes("&attemptId="));
  assert.equal(new URL(`http://localhost/${check.query}`).searchParams.get("attemptId"), starts[0].body.attemptId);
  assert.match(text(tree), /Fresh 1 question 1/);
});

test("the proxy preserves the exact attempt for status and submission and routes saved history", async () => {
  const forwarded = [];
  const proxy = load("../app/api/mock-test/route.ts", {
    "@/lib/backend-fetch": { backendFetch: async (url, init) => {
      forwarded.push({ url, init });
      return Response.json({ status: "ready", questions: [] });
    } },
  }, { Response, URL, URLSearchParams, AbortSignal, process: { env: {} } });
  const headers = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
  await proxy.GET(new Request("http://localhost/api/mock-test?courseId=course-1&topicId=topic-1&syllabusVersion=1&attemptId=exact-attempt", { headers }));
  assert.match(forwarded[0].url, /\/bank\?/);
  assert.equal(new URL(forwarded[0].url).searchParams.get("attemptId"), "exact-attempt");
  await proxy.GET(new Request("http://localhost/api/mock-test?action=attempts&courseId=course-1", { headers }));
  assert.match(forwarded[1].url, /\/attempts\?courseId=course-1$/);
  await proxy.POST(new Request("http://localhost/api/mock-test", {
    method: "POST", headers, body: JSON.stringify({
      action: "submit", courseId: "course-1", topicId: "topic-1", syllabusVersion: 1,
      attemptId: "exact-attempt", answers: { q1: 2 },
    }),
  }));
  const body = JSON.parse(forwarded[2].init.body);
  assert.equal(body.attemptId, "exact-attempt");
  assert.equal(body.answers.q1, 2);
  const unauthorized = await proxy.GET(new Request("http://localhost/api/mock-test?courseId=course-1"));
  assert.equal(unauthorized.status, 401);
  assert.equal(forwarded.length, 3);
});
