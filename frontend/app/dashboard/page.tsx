"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUpRight, Braces, ChevronDown, CircleUserRound, Coffee, FileCode, PanelsTopLeft, RefreshCcw, Webhook, type LucideIcon } from "lucide-react";
import { doc, getDoc } from "firebase/firestore";
import { signOut } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { NotesLibrary } from "@/components/notes-library";
import {
  getLearningGoals,
  type LearningGoal,
} from "@/lib/learning-data";
import { createProgressLoader, fetchUserProgress, selectContinueCourse, type CourseProgress, type ProgressSummary } from "@/lib/progress";
import { StudyPlanner, WeeklyLearningInsights } from "@/components/study-planner";

const sections = [
  "Dashboard",
  "Practice",
  "Notes",
  "Progress",
  "Study Planner",
] as const;
type Section = (typeof sections)[number];

function courseCardVisual(title: string): { Icon: LucideIcon; tone: string } {
  const name = title.toLowerCase();
  if (/\bjava\b/.test(name)) return { Icon: Coffee, tone: "bg-[#fbf0e8] text-[#9b5237]" };
  if (/\bpython\b/.test(name)) return { Icon: Braces, tone: "bg-[#edf5f3] text-[#176b59]" };
  if (/playwright/.test(name)) return { Icon: PanelsTopLeft, tone: "bg-[#f0f3ec] text-[#526b43]" };
  if (/typescript/.test(name)) return { Icon: FileCode, tone: "bg-[#edf2fa] text-[#3d5f88]" };
  if (/javascript/.test(name)) return { Icon: Braces, tone: "bg-[#faf4e7] text-[#85651e]" };
  if (/\bapi\b/.test(name)) return { Icon: Webhook, tone: "bg-[#edf5f3] text-[#176b59]" };
  return { Icon: FileCode, tone: "bg-[#f0f4ef] text-[#52645b]" };
}

function courseCardStatus(course: CourseProgress) {
  if (course.status === "completed") return { label: "Completed", tone: "bg-[#e8f3e9] text-[#31553d]" };
  if (course.status === "in_progress") return { label: "In progress", tone: "bg-[#f5f1e5] text-[#725d27]" };
  if (course.syllabusStatus === "generating") return { label: "Preparing syllabus", tone: "bg-[#eef3f5] text-[#456273]" };
  if (course.syllabusStatus === "failed") return { label: "Needs attention", tone: "bg-[#fbefed] text-[#913e31]" };
  if (course.syllabusStatus === "unavailable") return { label: "Progress unavailable", tone: "bg-[#f0f1ee] text-[#58655e]" };
  if (course.syllabusStatus === "not_generated") return { label: "Syllabus needed", tone: "bg-[#f0f1ee] text-[#58655e]" };
  if (course.totalLessons === 0) return { label: "No lessons yet", tone: "bg-[#f0f1ee] text-[#58655e]" };
  return { label: "Not started", tone: "bg-[#f0f1ee] text-[#58655e]" };
}

function courseCardAction(course: CourseProgress) {
  if (course.status === "completed") return "Review course";
  if (course.status === "in_progress") return "Continue learning";
  if (course.syllabusStatus === "ready" && course.totalLessons > 0) return "Start learning";
  return "Open course";
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [section, setSection] = useState<Section>("Dashboard");
  const [profileData, setProfileData] = useState<{ userId: string; name: string } | null>(null);
  const [goalsData, setGoalsData] = useState<{ userId: string; goals: LearningGoal[] } | null>(null);
  const profileName = profileData && profileData.userId === user?.uid ? profileData.name : "Learner";
  const goals = useMemo(() => goalsData && goalsData.userId === user?.uid ? goalsData.goals : [], [goalsData, user?.uid]);
  const [dataLoading, setDataLoading] = useState(true);
  const [courseListLoading, setCourseListLoading] = useState(false);
  const [courseRefreshKey, setCourseRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [progressData, setProgressData] = useState<{ userId: string; summary: ProgressSummary } | null>(null);
  const progressSummary = progressData && progressData.userId === user?.uid ? progressData.summary : null;
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressError, setProgressError] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const accountMenu = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const loadedGoalsUserId = useRef<string | null>(null);
  const progressLoader = useMemo(() => user ? createProgressLoader(
    async () => fetchUserProgress(await user.getIdToken()),
    {
      setSummary: (summary) => setProgressData({ userId: user.uid, summary }),
      setError: setProgressError,
      setLoading: setProgressLoading,
    },
    () => auth.currentUser?.uid === user.uid,
  ) : null, [user]);
  const continueCourse = selectContinueCourse(progressSummary?.courses ?? []);
  const allCoursesCompleted = !!progressSummary
    && progressSummary.totalCourses > 0
    && progressSummary.completedCourses === progressSummary.totalCourses;
  const courseCards = useMemo(() => {
    const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
    if (progressSummary) {
      return progressSummary.courses.map((course) => ({ ...course, goal: goalsById.get(course.courseId) }))
        .sort((first, second) => first.title.localeCompare(second.title) || first.courseId.localeCompare(second.courseId));
    }
    return goals.map((goal) => ({
      courseId: goal.id,
      title: goal.courseName,
      goal,
      syllabusStatus: "unavailable" as const,
      completionRate: 0,
      completedLessons: 0,
      totalLessons: 0,
      currentLesson: null,
      nextLesson: null,
      lastStudiedAt: null,
      status: "not_started" as const,
    })).sort((first, second) => first.title.localeCompare(second.title) || first.courseId.localeCompare(second.courseId));
  }, [goals, progressSummary]);

  const loadLearningData = useCallback(async (initial = false) => {
    if (!user) return;
    const currentUser = user;
    if (initial) setDataLoading(true);
    else setCourseListLoading(true);
    setError("");
    try {
      const profileRef = doc(db, "users", currentUser.uid);
      const [profileSnapshot, savedGoals] = await Promise.all([
        getDoc(profileRef),
        getLearningGoals(currentUser.uid),
      ]);
      if (auth.currentUser?.uid !== currentUser.uid) return;
      const profile = profileSnapshot.data();
      setProfileData({ userId: currentUser.uid, name: currentUser.displayName || profile?.displayName || "Learner" });
      setGoalsData({ userId: currentUser.uid, goals: savedGoals });
    } catch (loadError) {
      if (auth.currentUser?.uid === currentUser.uid) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load your learning data.");
      }
    } finally {
      if (auth.currentUser?.uid === currentUser.uid) {
        setDataLoading(false);
        setCourseListLoading(false);
      }
    }
  }, [user]);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/signin");
  }, [authLoading, router, user]);

  useEffect(() => {
    const currentUserId = user?.uid ?? null;
    void loadLearningData(loadedGoalsUserId.current !== currentUserId).finally(() => {
      if (currentUserId) loadedGoalsUserId.current = currentUserId;
    });
  }, [courseRefreshKey, loadLearningData, user?.uid]);

  useEffect(() => {
    if (section === "Dashboard" || section === "Progress") void progressLoader?.();
  }, [progressLoader, section]);

  useEffect(() => {
    function refreshOnReturn() {
      if (document.visibilityState !== "visible") return;
      void progressLoader?.();
      void loadLearningData(false);
    }
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => document.removeEventListener("visibilitychange", refreshOnReturn);
  }, [loadLearningData, progressLoader]);

  useEffect(() => {
    if (!accountOpen) return;
    function closeOutside(event: PointerEvent) {
      if (accountMenu.current && !accountMenu.current.contains(event.target as Node)) setAccountOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAccountOpen(false);
        accountButton.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [accountOpen]);

  async function handleSignOut() {
    setAccountOpen(false);
    await signOut(auth);
    router.replace("/");
  }

  if (authLoading || !user || dataLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f6f5ef] text-sm text-[#68736d]">
        Loading your learning space...
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-[#f6f5ef] text-[#1b302b]">
      <header className="flex h-[72px] items-center justify-between border-b border-[#e0e2d9] bg-white px-5 sm:px-8">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          LearnOS <span className="text-[#d16445]">AI</span>
        </Link>
        <div className="relative" ref={accountMenu}>
          <button aria-controls="account-dropdown" aria-expanded={accountOpen} aria-label={`Account: ${profileName}`} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-[#d9ddd5] bg-white px-3 py-2 text-sm font-semibold transition hover:border-[#1b6657] hover:bg-[#f6f8f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]" onClick={() => setAccountOpen((open) => !open)} ref={accountButton} type="button">
            <CircleUserRound aria-hidden="true" className="text-[#1b6657]" size={19} />
            <span className="max-w-36 truncate">{profileName}</span>
            <ChevronDown aria-hidden="true" className={`transition-transform ${accountOpen ? "rotate-180" : ""}`} size={15} />
          </button>
          <div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-lg border border-[#e0e2d9] bg-white p-4 shadow-lg" hidden={!accountOpen} id="account-dropdown" role="group" aria-label="Account details">
            <p className="break-words font-semibold text-[#1b302b]">{profileName}</p>
            {user.email && <p className="mt-1 break-all text-sm text-[#68736d]">{user.email}</p>}
            <div className="mt-4 border-t border-[#edf0e9] pt-3">
              <button className="w-full rounded-md px-3 py-2 text-left text-sm font-semibold text-[#9b3b2b] transition hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]" onClick={() => void handleSignOut()} type="button">Log out</button>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-8 px-5 py-7 sm:px-8 lg:grid-cols-[230px_minmax(0,1fr)] lg:py-10">
        <aside>
          <nav aria-label="Dashboard sections" className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible">
            {sections.map((item) => (
              <button
                aria-current={section === item ? "page" : undefined}
                className={`shrink-0 rounded-md px-3 py-2.5 text-left text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] ${section === item ? "bg-[#1b302b] font-semibold text-white" : "text-[#586761] hover:bg-white"}`}
                key={item}
                onClick={() => setSection(item)}
                type="button"
              >
                {item}
              </button>
            ))}
          </nav>
        </aside>

        <main className="min-w-0">
          <div className="mb-8">
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{section === "Dashboard" ? `Welcome back, ${profileName.split(" ")[0]}` : section === "Progress" ? "Your Learning Overview" : section}</h1>
          </div>

          {error && <p className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{error}</p>}

          {section === "Dashboard" ? (
            <div className="space-y-6">
              <section className="grid gap-5 rounded-lg border border-[#dce3db] bg-white p-5 shadow-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-6">
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#c35d42]">Your learning</p>
                  {progressLoading && !progressSummary ? <div className="mt-3 h-6 w-48 animate-pulse rounded bg-[#eef1ed]" /> : continueCourse ? <>
                    <h2 className="mt-2 break-words text-xl font-semibold tracking-tight text-[#19352d]">{continueCourse.currentLesson ? "Continue your lesson" : continueCourse.nextLesson ? "Today's focus" : "Continue your course"}</h2>
                    <p className="mt-1 break-words text-sm text-[#68736d]">{continueCourse.title}{(continueCourse.currentLesson || continueCourse.nextLesson) ? ` · ${continueCourse.currentLesson ?? continueCourse.nextLesson}` : ""}</p>
                    {continueCourse.totalLessons > 0 ? <div className="mt-4 max-w-lg">
                      <div className="mb-1.5 flex items-center justify-between text-xs"><span className="text-[#68736d]">Course progress</span><span className="font-semibold text-[#19352d]">{continueCourse.completedLessons} / {continueCourse.totalLessons} lessons</span></div>
                      <progress aria-label={`${continueCourse.title}: ${continueCourse.completedLessons} of ${continueCourse.totalLessons} lessons complete`} className="block h-1.5 w-full accent-[#176b59]" max={100} value={continueCourse.completionRate} />
                    </div> : <p className="mt-3 text-xs text-[#78847c]">{continueCourse.syllabusStatus === "failed" ? "Syllabus generation failed. Open the course to retry." : continueCourse.syllabusStatus === "generating" ? "Your syllabus is being prepared." : "Generate a syllabus to see your next lesson."}</p>}
                  </> : progressError ? <>
                    <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#19352d]">Your learning focus</h2>
                    <p className="mt-1 text-sm text-[#68736d]">Progress is unavailable right now; retry to load your saved course activity.</p>
                  </> : progressSummary?.totalCourses === 0 ? <>
                    <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#19352d]">Start with a learning goal</h2>
                    <p className="mt-1 text-sm text-[#68736d]">Your next lesson will appear here once a course and syllabus are saved.</p>
                  </> : allCoursesCompleted ? <>
                    <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#19352d]">Your courses are complete</h2>
                    <p className="mt-1 text-sm text-[#68736d]">Start a new learning goal when you are ready for the next subject.</p>
                  </> : courseCards.length > 0 ? <>
                    <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#19352d]">Choose a course to continue</h2>
                    <p className="mt-1 text-sm text-[#68736d]">Your saved courses do not have a usable lesson recommendation yet.</p>
                  </> : <>
                    <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#19352d]">Start with a learning goal</h2>
                    <p className="mt-1 text-sm text-[#68736d]">Your next lesson will appear here once a course and syllabus are saved.</p>
                  </>}
                  {progressError && <button className="mt-2 text-xs font-semibold text-[#8a5145] underline underline-offset-2" disabled={progressLoading} onClick={() => void progressLoader?.()} type="button">Retry progress</button>}
                </div>
                {continueCourse ? <Link className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#176b59] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#125644] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59]" href={`/dashboard/courses/${continueCourse.courseId}?lesson=${encodeURIComponent(continueCourse.currentLesson ?? continueCourse.nextLesson ?? "")}`}>
                  Continue learning <ArrowUpRight aria-hidden="true" size={16} />
                </Link> : courseCards.length > 0 && !progressError && !allCoursesCompleted ? <Link className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-[#cbd8d0] bg-white px-4 py-2.5 text-sm font-semibold text-[#176b59] hover:bg-[#f3f8f4]" href={`/dashboard/courses/${courseCards.find((course) => course.status !== "completed")?.courseId ?? courseCards[0].courseId}`}>
                  Open a course <ArrowUpRight aria-hidden="true" size={16} />
                </Link> : <Link className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#176b59] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#125644] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59]" href="/dashboard/new">
                  {allCoursesCompleted ? "Create a new goal" : "Create a learning goal"} <ArrowUpRight aria-hidden="true" size={16} />
                </Link>}
              </section>

              <WeeklyLearningInsights courses={progressSummary?.courses ?? []} onOpenPlanner={() => setSection("Study Planner")} />

              <div>
              <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Your courses</h2>
                  <p className="mt-1 text-sm text-[#68736d]">{courseCards.length} {courseCards.length === 1 ? "course" : "courses"}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-[#d9ddd5] bg-white px-3 py-2 text-sm font-semibold text-[#1b302b] hover:border-[#1b6657] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:opacity-60" disabled={courseListLoading} onClick={() => { setCourseRefreshKey((value) => value + 1); void progressLoader?.(); }} type="button">
                    <RefreshCcw aria-hidden="true" className={`size-4 ${courseListLoading ? "animate-spin" : ""}`} /> Refresh courses
                  </button>
                  <Link className="rounded-md bg-[#d16445] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#b84f34] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d16445]" href="/dashboard/new">
                    + New learning goal
                  </Link>
                </div>
              </div>
              {courseCards.length > 0 ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {courseCards.map((course) => (
                    (() => {
                      const visual = courseCardVisual(course.title);
                      const status = courseCardStatus(course);
                      const lessonTitle = course.currentLesson ?? course.nextLesson;
                      const hasProgress = course.totalLessons > 0;
                      const Icon = visual.Icon;
                      return <Link
                        aria-label={`${courseCardAction(course)}: ${course.title}`}
                        className="group flex h-full min-h-64 min-w-0 flex-col rounded-xl border border-[#dce3db] bg-white p-5 shadow-[0_2px_10px_rgba(27,48,43,0.035)] transition-colors hover:border-[#b8c9bd] hover:shadow-[0_8px_24px_rgba(27,48,43,0.09)] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[#176b59] sm:p-6"
                        href={`/dashboard/courses/${course.courseId}`}
                        key={course.courseId}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <span aria-hidden="true" className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${visual.tone}`}>
                            <Icon size={20} strokeWidth={1.8} />
                          </span>
                          <span className={`max-w-[65%] rounded-full px-2.5 py-1 text-[0.68rem] font-semibold leading-4 ${status.tone}`}>
                            {status.label}
                          </span>
                        </div>

                        <div className="mt-4 min-w-0">
                          <h3 className="break-words text-lg font-semibold leading-6 tracking-tight text-[#19352d] group-hover:text-[#176b59]">{course.title}</h3>
                          {course.goal?.goalText && <p className="mt-2 line-clamp-2 break-words text-sm leading-5 text-[#68736d]">{course.goal.goalText}</p>}
                        </div>

                        <div className="mt-auto pt-5">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="text-xs font-medium text-[#586761]">{hasProgress ? `${course.completedLessons} of ${course.totalLessons} lessons` : "Lesson progress"}</span>
                            {hasProgress && <span className="shrink-0 text-sm font-semibold tabular-nums text-[#19352d]">{course.completionRate}%</span>}
                          </div>
                          {hasProgress
                            ? <progress aria-label={`${course.title}: ${course.completedLessons} of ${course.totalLessons} lessons complete`} className="mt-2 block h-2 w-full overflow-hidden rounded-full accent-[#176b59]" max={100} value={course.completionRate} />
                            : <p className="mt-2 text-xs text-[#78847c]">Progress will appear when lessons are available.</p>}

                          {lessonTitle && <p className="mt-3 min-w-0 break-words text-xs leading-5 text-[#68736d]">
                            <span className="font-semibold text-[#52645b]">{course.currentLesson ? "Current lesson" : "Next lesson"}</span>
                            <span aria-hidden="true"> · </span>{lessonTitle}
                          </p>}

                          <div className="mt-4 flex min-h-11 items-center justify-between gap-3 border-t border-[#edf0e9] pt-3 text-sm font-semibold text-[#176b59]">
                            <span>{courseCardAction(course)}</span>
                            <ArrowRight aria-hidden="true" className="shrink-0 transition-transform group-hover:translate-x-0.5" size={17} />
                          </div>
                        </div>
                      </Link>;
                    })()
                  ))}
                </div>
              ) : (
                <section className="rounded-lg border border-[#e0e2d9] bg-white p-7">
                  <h3 className="text-lg font-semibold">Your first course starts with a goal</h3>
                  <p className="mt-2 text-sm leading-6 text-[#68736d]">Add a subject and a little context to set up your learning space.</p>
                </section>
              )}
              </div>
            </div>
          ) : section === "Notes" ? (
            <NotesLibrary />
          ) : section === "Progress" ? (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Learning progress</h2>
                  <p className="mt-1 text-sm text-[#68736d]">Recorded lesson confirmations show course activity; they do not measure mastery.</p>
                </div>
                <button
                  className="inline-flex items-center gap-2 rounded-md border border-[#d9ddd5] bg-white px-3 py-2 text-sm font-semibold text-[#1b302b] transition hover:border-[#1b6657] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]"
                  disabled={progressLoading || !progressLoader}
                  onClick={() => void progressLoader?.()}
                  type="button"
                >
                  <RefreshCcw aria-hidden="true" className="size-4" />
                  Refresh
                </button>
              </div>

              {progressError ? (
                <section className="rounded-lg border border-red-200 bg-red-50 p-5 text-red-800" role="alert">
                  <p className="font-semibold">Progress could not be loaded.</p>
                  <p className="mt-1 text-sm">{progressError}</p>
                  <button className="mt-3 rounded-md border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700 disabled:opacity-60" disabled={progressLoading || !progressLoader} onClick={() => void progressLoader?.()} type="button">
                    Retry
                  </button>
                </section>
              ) : progressLoading || !progressSummary ? (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  {[...Array(4)].map((_, index) => (
                    <div className="h-32 animate-pulse rounded-lg border border-[#e0e2d9] bg-[#f6f5ef]" key={index} />
                  ))}
                </div>
              ) : progressSummary.totalCourses === 0 ? (
                <section className="rounded-lg border border-[#e0e2d9] bg-white p-7">
                  <h3 className="text-lg font-semibold">No courses yet</h3>
                  <p className="mt-2 text-sm leading-6 text-[#68736d]">Create your first learning goal to start tracking progress across your course journey.</p>
                  <Link className="mt-4 inline-flex rounded-md bg-[#1b302b] px-4 py-2.5 text-sm font-semibold text-white" href="/dashboard/new">Create a course</Link>
                </section>
              ) : (
                <>
                  <dl className={`grid gap-px overflow-hidden rounded-lg border border-[#dce3db] bg-[#dce3db] ${progressSummary.lastStudyActivity ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-3"}`}>
                    <div className="bg-white px-4 py-4 sm:px-5">
                      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-[#68776e]">Overall completion</dt>
                      <dd className="mt-2 text-3xl font-semibold tracking-tight text-[#19352d]">{Math.round(progressSummary.overallProgress)}%</dd>
                    </div>
                    <div className="bg-white px-4 py-4 sm:px-5">
                      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-[#68776e]">Courses in progress</dt>
                      <dd className="mt-2 text-3xl font-semibold tracking-tight text-[#19352d]">{progressSummary.coursesInProgress}</dd>
                    </div>
                    <div className="bg-white px-4 py-4 sm:px-5">
                      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-[#68776e]">Completed courses</dt>
                      <dd className="mt-2 text-3xl font-semibold tracking-tight text-[#19352d]">{progressSummary.completedCourses}</dd>
                    </div>
                    {progressSummary.lastStudyActivity && <div className="bg-white px-4 py-4 sm:px-5">
                      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-[#68776e]">Recorded activity</dt>
                      <dd className="mt-2 text-sm font-semibold text-[#19352d]">{progressSummary.lastStudyActivity.lastStudyDate ? new Date(progressSummary.lastStudyActivity.lastStudyDate).toLocaleDateString() : "Date not recorded"}</dd>
                      <dd className="mt-1 text-xs text-[#68736d]">
                        {progressSummary.lastStudyActivity.studySessions != null ? `${progressSummary.lastStudyActivity.studySessions} sessions` : ""}
                        {progressSummary.lastStudyActivity.studySessions != null && progressSummary.lastStudyActivity.totalMinutesStudied != null ? " · " : ""}
                        {progressSummary.lastStudyActivity.totalMinutesStudied != null ? `${progressSummary.lastStudyActivity.totalMinutesStudied} min` : ""}
                      </dd>
                    </div>}
                  </dl>

                  <WeeklyLearningInsights courses={progressSummary.courses} onOpenPlanner={() => setSection("Study Planner")} />

                  {progressSummary.courses.length === 0 ? (
                    <section className="rounded-lg border border-[#e0e2d9] bg-white p-7">
                      <h3 className="text-lg font-semibold">No learning activity has started yet</h3>
                      <p className="mt-2 text-sm leading-6 text-[#68736d]">Your courses exist, but no lesson progress has been recorded. Use the course workspace to begin a lesson and track completion.</p>
                    </section>
                  ) : (
                    <section aria-label="Course progress">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold text-[#19352d]">Your courses</h3>
                        <span className="text-xs text-[#78847c]">{progressSummary.totalCourses} total</span>
                      </div>
                      <ul className="grid gap-3 md:grid-cols-2">
                      {progressSummary.courses.map((course: CourseProgress) => (
                        <li className="min-w-0 rounded-lg border border-[#dce3db] bg-white p-4 shadow-sm transition hover:border-[#bdcec1] hover:shadow-md sm:p-5" key={course.courseId}>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h4 className="min-w-0 flex-1 break-words font-semibold text-[#19352d]">{course.title}</h4>
                              <span className={`rounded px-2 py-0.5 text-[0.68rem] font-semibold ${course.status === "completed" ? "bg-[#e3efe6] text-[#31553d]" : course.status === "in_progress" ? "bg-[#f5ecd9] text-[#805a21]" : "bg-[#eef1ed] text-[#68736d]"}`}>
                                {course.status === "completed" ? "Completed" : course.status === "in_progress" ? "In progress" : "Not started"}
                              </span>
                            </div>
                            {course.syllabusStatus !== "ready" && <p className="mt-1 text-xs font-medium text-[#68736d]">{course.syllabusStatus === "not_generated" ? "Syllabus not generated" : course.syllabusStatus === "generating" ? "Syllabus generation in progress" : course.syllabusStatus === "failed" ? "Syllabus generation failed" : "Saved syllabus unavailable"}</p>}
                          </div>

                          {course.totalLessons > 0 ? <div className="mt-4">
                            <div className="flex items-center justify-between gap-3 text-xs">
                              <span className="text-[#68736d]">{course.completedLessons} / {course.totalLessons} lessons</span>
                              <span className="font-semibold text-[#19352d]">{course.completionRate}%</span>
                            </div>
                            <progress aria-label={`${course.title}: ${course.completedLessons} of ${course.totalLessons} lessons completed`} className="mt-2 block h-1.5 w-full accent-[#176b59]" max={100} value={course.completionRate} />
                          </div> : <p className="mt-4 text-xs text-[#78847c]">Lesson progress will be available when the syllabus is saved.</p>}

                          <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-[#edf0ec] pt-3">
                            <div className="min-w-0 text-xs text-[#68736d]">
                              {(course.currentLesson || course.nextLesson) && <p className="max-w-56 truncate"><span className="font-medium text-[#52645b]">Next:</span> {course.currentLesson ?? course.nextLesson}</p>}
                              {course.lastStudiedAt && <p className="mt-1">Last active {new Date(course.lastStudiedAt).toLocaleDateString()}</p>}
                            </div>
                            <Link className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-[#cbd8d0] px-3 py-1.5 text-sm font-semibold text-[#176b59] transition hover:border-[#176b59] hover:bg-[#f3f8f4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59]" href={`/dashboard/courses/${course.courseId}`}>
                              Continue <ArrowUpRight aria-hidden="true" size={15} />
                            </Link>
                          </div>
                        </li>
                      ))}
                      </ul>
                    </section>
                  )}
                </>
              )}
            </div>
          ) : section === "Study Planner" ? (
            <StudyPlanner />
          ) : (
            <section className="rounded-lg border border-[#e0e2d9] bg-white p-7 sm:p-9">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#d16445]">Coming next</p>
              <h2 className="mt-3 text-xl font-semibold">{section}</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-[#68736d]">This space is ready for your learning journey. Your goals and progress are already saved in your workspace.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
