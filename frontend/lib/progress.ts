export type ProgressStatus = "not_started" | "in_progress" | "completed";

export type CourseProgress = {
  courseId: string;
  title: string;
  syllabusStatus: "ready" | "not_generated" | "generating" | "failed" | "unavailable";
  completionRate: number;
  completedLessons: number;
  totalLessons: number;
  remainingLessons: number;
  lessons: { topicId: string; title: string; moduleTitle: string; status: ProgressStatus }[];
  currentLesson: string | null;
  nextLesson: string | null;
  lastStudiedAt: string | null;
  status: ProgressStatus;
};

export type ProgressActivitySummary = {
  lastStudyDate: string | null;
  studySessions: number | null;
  totalMinutesStudied: number | null;
} | null;

export type ProgressSummary = {
  overallProgress: number;
  coursesInProgress: number;
  completedCourses: number;
  totalCourses: number;
  lastStudyActivity: ProgressActivitySummary;
  courses: CourseProgress[];
};

/** Select the most recently active unfinished course, with a stable ID tie-break. */
export function selectContinueCourse(courses: CourseProgress[]) {
  return courses
    .filter((course) => course.syllabusStatus === "ready"
      && course.totalLessons > 0
      && course.completedLessons < course.totalLessons
      && course.status !== "completed")
    .sort((first, second) => {
      const firstActivity = first.lastStudiedAt ? Date.parse(first.lastStudiedAt) : Number.NaN;
      const secondActivity = second.lastStudiedAt ? Date.parse(second.lastStudiedAt) : Number.NaN;
      const firstHasActivity = Number.isFinite(firstActivity);
      const secondHasActivity = Number.isFinite(secondActivity);
      if (firstHasActivity !== secondHasActivity) return firstHasActivity ? -1 : 1;
      if (firstHasActivity && secondHasActivity && firstActivity !== secondActivity) return secondActivity - firstActivity;
      return first.courseId < second.courseId ? -1 : first.courseId > second.courseId ? 1 : 0;
    })[0] ?? null;
}

export async function fetchUserProgress(token: string): Promise<ProgressSummary> {
  const response = await fetch("/api/progress", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.detail === "string" ? payload.detail : "Unable to load your progress.";
    throw new Error(detail);
  }

  return payload as ProgressSummary;
}

export function createProgressLoader(
  load: () => Promise<ProgressSummary>,
  callbacks: {
    setSummary: (summary: ProgressSummary) => void;
    setError: (message: string) => void;
    setLoading: (loading: boolean) => void;
  },
  isCurrent: () => boolean = () => true,
) {
  let inFlight: Promise<void> | null = null;

  return function loadProgress() {
    if (inFlight) return inFlight;

    callbacks.setLoading(true);
    callbacks.setError("");
    const request = (async () => {
      try {
        const summary = await load();
        if (isCurrent()) {
          callbacks.setSummary(summary);
          callbacks.setError("");
        }
      } catch (error) {
        if (isCurrent()) {
          const message = error instanceof Error && error.message.trim()
            ? error.message
            : "Unable to load your progress.";
          callbacks.setError(message);
        }
      } finally {
        if (isCurrent()) callbacks.setLoading(false);
        inFlight = null;
      }
    })();
    inFlight = request;
    return request;
  };
}
