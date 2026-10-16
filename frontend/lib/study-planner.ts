export type CalendarView = "month" | "week" | "day";

export type PlannerLesson = {
  lessonId: string;
  title: string;
  moduleTitle: string;
  status: "not_started" | "in_progress" | "completed";
};

export type PlannerCourse = {
  courseId: string;
  title: string;
  syllabusStatus: "ready" | "not_generated" | "generating" | "failed" | "unavailable";
  activeLessonId: string | null;
  lessons: PlannerLesson[];
};

export type PlannerSession = {
  sessionId: string;
  courseId: string;
  courseTitle: string;
  lessonId: string | null;
  lessonTitle: string | null;
  startAt: string;
  durationMinutes: number;
  note: string;
  status: "scheduled" | "completed" | "cancelled";
};

export type CompletionActivity = {
  eventId: string;
  courseId: string;
  courseTitle: string;
  lessonId: string;
  lessonTitle: string;
  moduleTitle: string;
  completedAt: string;
};

export type WeeklyActivityDay = { date: string; completedLessons: number };

export type PlannerOverview = {
  courses: PlannerCourse[];
  sessions: PlannerSession[];
  completions: CompletionActivity[];
  weeklyTarget: number | null;
  weeklyCompletedLessons: number;
  weeklyActivity: WeeklyActivityDay[];
};

export type SessionDraft = {
  courseId: string;
  lessonId: string;
  date: string;
  time: string;
  durationMinutes: number;
  note: string;
};

export const FALLBACK_TIME_ZONE = "UTC";

export function getLocalTimeZone() {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!timeZone) return null;
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return null;
  }
}

export function isSupportedTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function dateKeyInTimeZone(value: Date | string, timeZone: string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function localDateTimeToUtc(dateKey: string, timeValue: string, timeZone: string) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!dateMatch || !timeMatch || !isSupportedTimeZone(timeZone)) return null;
  const [, year, month, day] = dateMatch.map(Number) as unknown as [string, number, number, number];
  const [, hour, minute] = timeMatch.map(Number) as unknown as [string, number, number];
  const localParts = [year, month, day, hour, minute];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const wallTimeAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const initial = new Date(wallTimeAsUtc);
  if (initial.getUTCFullYear() !== year || initial.getUTCMonth() !== month - 1 || initial.getUTCDate() !== day) return null;

  let candidate = wallTimeAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(candidate));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
    const representedWallTime = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
    const difference = wallTimeAsUtc - representedWallTime;
    if (difference === 0) break;
    candidate += difference;
  }
  const resolved = new Date(candidate);
  if (dateKeyInTimeZone(resolved, timeZone) !== dateKey
      || Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(resolved)) !== localParts[3]
      || Number(new Intl.DateTimeFormat("en-US", { timeZone, minute: "2-digit" }).format(resolved)) !== localParts[4]) return null;
  return resolved;
}

function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function startOfWeek(date: Date) {
  const mondayOffset = (date.getDay() + 6) % 7;
  return addDays(date, -mondayOffset);
}

export function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function visibleCalendarDates(view: CalendarView, selectedDate: Date) {
  if (view === "day") return [new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate())];
  if (view === "week") return Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(selectedDate), index));

  const firstOfMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
  const gridStart = startOfWeek(firstOfMonth);
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
}

export function calendarWindow(view: CalendarView, selectedDate: Date, timeZone = getLocalTimeZone() ?? FALLBACK_TIME_ZONE) {
  const dates = visibleCalendarDates(view, selectedDate);
  const startAt = localDateTimeToUtc(localDateKey(dates[0]), "00:00", timeZone);
  const endDate = addDays(dates[dates.length - 1], 1);
  const endAt = localDateTimeToUtc(localDateKey(endDate), "00:00", timeZone);
  if (!startAt || !endAt) throw new Error("The selected calendar range is invalid in this time zone.");
  return { startAt: startAt.toISOString(), endAt: endAt.toISOString() };
}

export function moveCalendarDate(date: Date, view: CalendarView, direction: -1 | 1) {
  if (view === "month") return new Date(date.getFullYear(), date.getMonth() + direction, 1);
  return addDays(date, direction * (view === "week" ? 7 : 1));
}

export function localSessionStart(dateValue: string, timeValue: string, now = new Date(), timeZone = getLocalTimeZone() ?? FALLBACK_TIME_ZONE) {
  const start = localDateTimeToUtc(dateValue, timeValue, timeZone);
  if (!start || start <= now) return null;
  return start.toISOString();
}

export function validateSessionDraft(draft: SessionDraft, now = new Date(), timeZone = getLocalTimeZone() ?? FALLBACK_TIME_ZONE) {
  if (!draft.courseId) return { error: "Choose a course.", startAt: null };
  const startAt = localSessionStart(draft.date, draft.time, now, timeZone);
  if (!startAt) return { error: "Choose a valid future date and time.", startAt: null };
  if (!Number.isInteger(draft.durationMinutes) || draft.durationMinutes < 15 || draft.durationMinutes > 240) {
    return { error: "Session duration must be between 15 and 240 minutes.", startAt: null };
  }
  if (draft.note.length > 1000) return { error: "Notes must be 1,000 characters or fewer.", startAt: null };
  return { error: "", startAt };
}

export function chooseRecommendedLesson(courses: PlannerCourse[]) {
  const available = courses.filter((course) => course.syllabusStatus === "ready" && course.lessons.length > 0);
  for (const course of available) {
    const active = course.lessons.find((lesson) => lesson.lessonId === course.activeLessonId && lesson.status !== "completed");
    if (active && course.lessons.some((lesson) => lesson.status === "in_progress")) return { course, lesson: active };
  }
  const orderedCourses = [
    ...available.filter((course) => course.lessons.some((lesson) => lesson.status === "in_progress")),
    ...available.filter((course) => !course.lessons.some((lesson) => lesson.status === "in_progress")),
  ];
  for (const course of orderedCourses) {
    const lesson = course.lessons.find((item) => item.status !== "completed");
    if (lesson) return { course, lesson };
  }
  return null;
}

async function requestPlanner<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/planner/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.detail === "string" ? payload.detail : "The study planner request failed.";
    throw new Error(message);
  }
  return payload as T;
}

export async function fetchPlannerOverview(token: string, date: Date, view: CalendarView, timeZone: string) {
  const range = calendarWindow(view, date, timeZone);
  const query = new URLSearchParams({ ...range, timeZone });
  return requestPlanner<PlannerOverview>(token, `overview?${query.toString()}`);
}

export async function createPlannerSession(token: string, draft: SessionDraft) {
  const validation = validateSessionDraft(draft);
  if (validation.error || !validation.startAt) throw new Error(validation.error);
  return requestPlanner<PlannerSession>(token, "sessions", "POST", {
    operationId: crypto.randomUUID(),
    courseId: draft.courseId,
    lessonId: draft.lessonId || null,
    startAt: validation.startAt,
    durationMinutes: draft.durationMinutes,
    note: draft.note.trim(),
  });
}

export async function updatePlannerSession(token: string, sessionId: string, draft: SessionDraft) {
  const validation = validateSessionDraft(draft);
  if (validation.error || !validation.startAt) throw new Error(validation.error);
  return requestPlanner<PlannerSession>(token, `sessions/${encodeURIComponent(sessionId)}`, "PATCH", {
    courseId: draft.courseId,
    lessonId: draft.lessonId || null,
    startAt: validation.startAt,
    durationMinutes: draft.durationMinutes,
    note: draft.note.trim(),
  });
}

export async function updatePlannerSessionStatus(token: string, sessionId: string, status: "completed" | "cancelled") {
  return requestPlanner<PlannerSession>(token, `sessions/${encodeURIComponent(sessionId)}/status`, "PATCH", { status });
}

export async function deletePlannerSession(token: string, sessionId: string) {
  return requestPlanner<void>(token, `sessions/${encodeURIComponent(sessionId)}`, "DELETE");
}

export async function saveWeeklyTarget(token: string, weeklyTarget: number | null) {
  return requestPlanner<{ weeklyTarget: number | null }>(token, "weekly-goal", "PUT", { weeklyTarget });
}
