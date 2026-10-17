export type ScenarioCourseSelection = { courseId: string; topicId: string };

export function selectScenarioCourse(courseId: string): ScenarioCourseSelection {
  return { courseId, topicId: "" };
}
