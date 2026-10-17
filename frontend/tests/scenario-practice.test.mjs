import assert from "node:assert/strict";
import test from "node:test";
import { selectScenarioCourse } from "../lib/scenario-practice.ts";

test("changing the selected course clears its previous topic selection", () => {
  const selection = { courseId: "python", topicId: "functions" };
  assert.deepEqual(selectScenarioCourse("playwright"), { courseId: "playwright", topicId: "" });
  assert.notEqual(selectScenarioCourse("playwright").topicId, selection.topicId);
});
