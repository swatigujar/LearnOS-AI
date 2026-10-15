import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarWindow,
  chooseRecommendedLesson,
  getLocalTimeZone,
  localDateKey,
  moveCalendarDate,
  validateSessionDraft,
  visibleCalendarDates,
} from "../lib/study-planner.ts";

test("month calendar is a Monday-first six-week grid with stable navigation", () => {
  const selected = new Date(2026, 9, 15, 12);
  const dates = visibleCalendarDates("month", selected);

  assert.equal(dates.length, 42);
  assert.equal(dates[0].getDay(), 1);
  assert.equal(localDateKey(moveCalendarDate(selected, "month", 1)), "2026-11-01");
  assert.equal(localDateKey(moveCalendarDate(selected, "month", -1)), "2026-09-01");
  assert.equal(calendarWindow("week", selected).endAt > calendarWindow("week", selected).startAt, true);
});

test("week and day navigation move by their displayed interval", () => {
  const selected = new Date(2026, 9, 15, 12);
  assert.equal(visibleCalendarDates("week", selected).length, 7);
  assert.equal(localDateKey(moveCalendarDate(selected, "week", 1)), "2026-10-22");
  assert.equal(localDateKey(moveCalendarDate(selected, "day", -1)), "2026-10-14");
  assert.equal(visibleCalendarDates("day", selected).length, 1);
});

test("session form rejects missing, past, malformed and out-of-range values", () => {
  const now = new Date(2026, 9, 15, 9, 0);
  const base = { courseId: "python", lessonId: "", date: "2026-10-15", time: "11:30", durationMinutes: 60, note: "" };
  assert.equal(validateSessionDraft({ ...base, courseId: "" }, now).error, "Choose a course.");
  assert.equal(validateSessionDraft({ ...base, time: "08:00" }, now).startAt, null);
  assert.equal(validateSessionDraft({ ...base, date: "2026-02-30" }, now).startAt, null);
  assert.match(validateSessionDraft({ ...base, durationMinutes: 10 }, now).error, /15 and 240/);
  assert.equal(validateSessionDraft(base, now).error, "");
});

test("recommendation chooses current incomplete context without treating unknown courses as lessons", () => {
  const courses = [
    { courseId: "new", title: "New", syllabusStatus: "not_generated", activeLessonId: null, lessons: [] },
    { courseId: "python", title: "Python", syllabusStatus: "ready", activeLessonId: "l2", lessons: [
      { lessonId: "l1", title: "Values", moduleTitle: "Basics", status: "completed" },
      { lessonId: "l2", title: "Variables", moduleTitle: "Basics", status: "in_progress" },
    ] },
  ];
  const recommendation = chooseRecommendedLesson(courses);
  assert.equal(recommendation.course.courseId, "python");
  assert.equal(recommendation.lesson.lessonId, "l2");
  assert.equal(chooseRecommendedLesson(courses.slice(0, 1)), null);
});

test("local time zone resolves to a non-empty IANA zone or UTC", () => {
  assert.equal(typeof getLocalTimeZone(), "string");
  assert.ok(getLocalTimeZone().length > 0);
});
