import assert from "node:assert/strict";
import test from "node:test";
import { buildCodeLabPrompt } from "../lib/code-lab.ts";

test("generate prompt stays in the selected lesson and labels code unexecuted", () => {
  const prompt = buildCodeLabPrompt("generate", "Variables and values");
  assert.match(prompt, /Variables and values/);
  assert.match(prompt, /Python/);
  assert.match(prompt, /Do not claim the code was executed/);
});

test("explain, debug, and test actions require and include learner code", () => {
  for (const action of ["explain", "debug", "tests"]) {
    assert.throws(() => buildCodeLabPrompt(action, "Functions"), /Add Python code/);
    assert.match(buildCodeLabPrompt(action, "Functions", "def add(a, b): return a + b"), /def add/);
  }
});

test("code lab rejects missing lesson context and oversized source", () => {
  assert.throws(() => buildCodeLabPrompt("generate", "  "), /Open a lesson/);
  assert.throws(() => buildCodeLabPrompt("explain", "Functions", "x".repeat(1401)), /1,400 characters/);
});
