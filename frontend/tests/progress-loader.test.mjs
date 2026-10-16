import assert from "node:assert/strict";
import test from "node:test";
import { createProgressLoader, selectContinueCourse } from "../lib/progress.ts";

function createState() {
  const state = {
    summary: null,
    error: "Previous network error",
    loading: false,
  };
  state.callbacks = {
    setSummary: (value) => { state.summary = value; },
    setError: (value) => { state.error = value; },
    setLoading: (value) => { state.loading = value; },
  };
  return state;
}

test("a successful refresh clears a stale error and updates summary and loading state", async () => {
  const state = createState();
  const summary = { totalCourses: 1, courses: [] };
  const loadProgress = createProgressLoader(async () => summary, state.callbacks);

  await loadProgress();

  assert.equal(state.summary, summary);
  assert.equal(state.error, "");
  assert.equal(state.loading, false);
});

test("a failed request retains a recoverable error and a later retry clears it", async () => {
  const state = createState();
  let shouldFail = true;
  const summary = { totalCourses: 0, courses: [] };
  const loadProgress = createProgressLoader(async () => {
    if (shouldFail) throw new Error("Firestore is unavailable.");
    return summary;
  }, state.callbacks);

  await loadProgress();
  assert.equal(state.error, "Firestore is unavailable.");
  assert.equal(state.loading, false);

  shouldFail = false;
  await loadProgress();
  assert.equal(state.summary, summary);
  assert.equal(state.error, "");
  assert.equal(state.loading, false);
});

test("concurrent refresh requests share one in-flight request", async () => {
  const state = createState();
  let resolveLoad;
  let calls = 0;
  const loadProgress = createProgressLoader(() => {
    calls += 1;
    return new Promise((resolve) => { resolveLoad = resolve; });
  }, state.callbacks);

  const firstRequest = loadProgress();
  const secondRequest = loadProgress();
  assert.equal(firstRequest, secondRequest);
  assert.equal(calls, 1);
  resolveLoad({ totalCourses: 0, courses: [] });
  await firstRequest;
});

test("Continue Learning prefers the most recently active eligible course", () => {
  const courses = [
    { courseId: "c", status: "in_progress", syllabusStatus: "ready", totalLessons: 4, completedLessons: 1, lastStudiedAt: "2026-01-02T00:00:00Z" },
    { courseId: "b", status: "not_started", syllabusStatus: "ready", totalLessons: 3, completedLessons: 0, lastStudiedAt: "2026-01-03T00:00:00Z" },
    { courseId: "a", status: "in_progress", syllabusStatus: "ready", totalLessons: 5, completedLessons: 2, lastStudiedAt: "2026-01-01T00:00:00Z" },
    { courseId: "done", status: "completed", syllabusStatus: "ready", totalLessons: 1, completedLessons: 1, lastStudiedAt: "2026-01-04T00:00:00Z" },
  ];

  assert.equal(selectContinueCourse(courses).courseId, "b");
});

test("Continue Learning uses a stable ID fallback and skips unusable syllabuses", () => {
  const courses = [
    { courseId: "z", status: "not_started", syllabusStatus: "ready", totalLessons: 2, completedLessons: 0, lastStudiedAt: null },
    { courseId: "a", status: "not_started", syllabusStatus: "ready", totalLessons: 1, completedLessons: 0, lastStudiedAt: "bad timestamp" },
    { courseId: "pending", status: "not_started", syllabusStatus: "generating", totalLessons: 0, completedLessons: 0, lastStudiedAt: null },
  ];

  assert.equal(selectContinueCourse(courses).courseId, "a");
  assert.equal(selectContinueCourse([{ ...courses[2], courseId: "only" }]), null);
});
