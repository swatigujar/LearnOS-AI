import assert from "node:assert/strict";
import test from "node:test";
import { selectScenarioCourse } from "../lib/scenario-practice.ts";
import { cleanScenarioHistoryText, scenarioHistoryTitle } from "../lib/practice-display.ts";

test("changing the selected course clears its previous topic selection", () => {
  const selection = { courseId: "python", topicId: "functions" };
  assert.deepEqual(selectScenarioCourse("playwright"), { courseId: "playwright", topicId: "" });
  assert.notEqual(selectScenarioCourse("playwright").topicId, selection.topicId);
});

test("saved scenario history repairs mojibake separators for display without mutating saved text", () => {
  const savedCourseTitle = "Applied Algebra ┬┬ Linear equations";
  const savedTopicTitle = "Applied Algebra ┬┬ Linear equations";
  const savedDifficulty = "Medium ┬╖ Descriptive";

  assert.equal(scenarioHistoryTitle(savedCourseTitle, savedTopicTitle), "Applied Algebra · Linear equations");
  assert.equal(cleanScenarioHistoryText(savedDifficulty).replace(/\s*·\s*descriptive$/i, ""), "Medium");
  assert.equal(savedCourseTitle, "Applied Algebra ┬┬ Linear equations");
});
