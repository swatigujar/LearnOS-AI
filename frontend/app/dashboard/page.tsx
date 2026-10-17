"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Braces,
  ChevronDown,
  CircleUserRound,
  Coffee,
  FileCode,
  PanelsTopLeft,
  RefreshCcw,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { doc, getDoc } from "firebase/firestore";
import { signOut } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { NotesLibrary } from "@/components/notes-library";
import { PracticeCenter } from "@/components/practice-center";
import {
  getLearningGoals,
  type LearningGoal,
} from "@/lib/learning-data";
import {
  createProgressLoader,
  fetchUserProgress,
  selectContinueCourse,
  type CourseProgress,
  type ProgressSummary,
} from "@/lib/progress";

const sections = ["Dashboard", "Practice", "Notes", "Progress / Mastery"] as const;
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
      return progressSummary.courses.map((course) => ({
        ...course,
        goal: goalsById.get(course.courseId),
      })).sort((first, second) => first.title.localeCompare(second.title) || first.courseId.localeCompare(second.courseId));
    }
    return goals.map((goal) => ({
      courseId: goal.id,
      title: goal.courseName,
      goal,
      syllabusStatus: "unavailable" as const,
      completionRate: 0,
      completedLessons: 0,
      totalLessons: 0,
      remainingLessons: 0,
      lessons: [],
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
    if (!user) return;
    if (section === "Dashboard") void progressLoader?.();
  }, [progressLoader, section, user]);

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

  const handleRefresh = () => {
    setCourseRefreshKey((val) => val + 1);
    void progressLoader?.();
  };

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
          <button
            aria-controls="account-dropdown"
            aria-expanded={accountOpen}
            aria-label={`Account: ${profileName}`}
            className="inline-flex min-h-10 items-center gap-2 rounded-md border border-[#d9ddd5] bg-white px-3 py-2 text-sm font-semibold transition hover:border-[#1b6657] hover:bg-[#f6f8f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]"
            onClick={() => setAccountOpen((open) => !open)}
            ref={accountButton}
            type="button"
          >
            <CircleUserRound aria-hidden="true" className="text-[#1b6657]" size={19} />
            <span className="max-w-36 truncate">{profileName}</span>
            <ChevronDown aria-hidden="true" className={`transition-transform ${accountOpen ? "rotate-180" : ""}`} size={15} />
          </button>
          <div
            className="absolute right-0 top-full z-30 mt-2 w-64 rounded-lg border border-[#e0e2d9] bg-white p-4 shadow-lg"
            hidden={!accountOpen}
            id="account-dropdown"
            role="group"
            aria-label="Account details"
          >
            <p className="break-words font-semibold text-[#1b302b]">{profileName}</p>
            {user.email && <p className="mt-1 break-all text-sm text-[#68736d]">{user.email}</p>}
            <div className="mt-4 border-t border-[#edf0e9] pt-3">
              <button
                className="w-full rounded-md px-3 py-2 text-left text-sm font-semibold text-[#9b3b2b] transition hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]"
                onClick={() => void handleSignOut()}
                type="button"
              >
                Log out
              </button>
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
                className={`shrink-0 rounded-md px-3 py-2.5 text-left text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] ${
                  section === item ? "bg-[#1b302b] font-semibold text-white" : "text-[#586761] hover:bg-white"
                }`}
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
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              {section === "Dashboard" ? `Welcome, ${profileName.split(" ")[0]}` : section}
            </h1>
          </div>

          {error && (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
              <span>{error}</span>
              <button
                className="font-semibold underline underline-offset-2 hover:text-red-950"
                onClick={handleRefresh}
                type="button"
              >
                Retry
              </button>
            </div>
          )}

          {section === "Dashboard" ? (
            <div className="space-y-6">
              {/* Top Focus / Next Lesson Banner */}
              <section className="grid gap-5 rounded-lg border border-[#dce3db] bg-white p-5 shadow-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-6">
                <div className="min-w-0">
                  <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#d16445]">Your learning</p>
                  {progressLoading && !progressSummary ? (
                    <div className="mt-3 h-6 w-48 animate-pulse rounded bg-[#eef1ed]" />
                  ) : continueCourse ? (
                    <>
                      <h2 className="mt-2 break-words text-xl font-semibold tracking-tight text-[#19352d]">
                        {continueCourse.currentLesson ? "Continue your lesson" : continueCourse.nextLesson ? "Today's focus" : "Continue your course"}
                      </h2>
                      <p className="mt-1 break-words text-sm text-[#68736d]">
                        {continueCourse.title}
                        {continueCourse.currentLesson || continueCourse.nextLesson ? ` · ${continueCourse.currentLesson ?? continueCourse.nextLesson}` : ""}
                      </p>
                      {continueCourse.totalLessons > 0 ? (
                        <div className="mt-4 max-w-lg">
                          <div className="mb-1.5 flex items-center justify-between text-xs">
                            <span className="text-[#68736d]">Course progress</span>
                            <span className="font-semibold text-[#19352d]">{continueCourse.completedLessons} / {continueCourse.totalLessons} lessons ({continueCourse.completionRate}%)</span>
                          </div>
                          <progress
                            aria-label={`${continueCourse.title}: ${continueCourse.completedLessons} of ${continueCourse.totalLessons} lessons complete`}
                            className="block h-2 w-full accent-[#176b59]"
                            max={100}
                            value={continueCourse.completionRate}
                          />
                        </div>
                      ) : (
                        <p className="mt-3 text-xs text-[#78847c]">
                          {continueCourse.syllabusStatus === "failed"
                            ? "Syllabus generation failed. Open the course to retry."
                            : continueCourse.syllabusStatus === "generating"
                            ? "Your syllabus is being prepared."
                            : "Generate a syllabus to see your next lesson."}
                        </p>
                      )}
                    </>
                  ) : progressError ? (
                    <>
                      <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#19352d]">Your learning focus</h2>
                      <p className="mt-1 text-sm text-[#68736d]">Progress is unavailable right now; retry to load your saved course activity.</p>
                      <button
                        className="mt-2 text-xs font-semibold text-[#d16445] underline underline-offset-2"
                        disabled={progressLoading}
                        onClick={() => void progressLoader?.()}
                        type="button"
                      >
                        Retry progress
                      </button>
                    </>
                  ) : allCoursesCompleted ? (
                    <>
                      <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#19352d]">All courses completed!</h2>
                      <p className="mt-1 text-sm text-[#68736d]">Great work! Start a new learning goal when you are ready for the next subject.</p>
                    </>
                  ) : courseCards.length > 0 ? (
                    <>
                      <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#19352d]">Choose a course to continue</h2>
                      <p className="mt-1 text-sm text-[#68736d]">Pick a course below to view the syllabus and continue learning with your AI tutor.</p>
                    </>
                  ) : (
                    <>
                      <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#19352d]">Start with a learning goal</h2>
                      <p className="mt-1 text-sm text-[#68736d]">Your next lesson and progress will appear here once a course and syllabus are saved.</p>
                    </>
                  )}
                </div>

                {continueCourse ? (
                  <Link
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#176b59] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#125644] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59]"
                    href={`/dashboard/courses/${continueCourse.courseId}`}
                  >
                    Continue learning <ArrowUpRight aria-hidden="true" size={16} />
                  </Link>
                ) : courseCards.length > 0 && !allCoursesCompleted ? (
                  <Link
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-[#cbd8d0] bg-white px-4 py-2.5 text-sm font-semibold text-[#176b59] hover:bg-[#f3f8f4]"
                    href={`/dashboard/courses/${courseCards.find((c) => c.status !== "completed")?.courseId ?? courseCards[0].courseId}`}
                  >
                    Open course <ArrowUpRight aria-hidden="true" size={16} />
                  </Link>
                ) : (
                  <Link
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#d16445] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#b84f34] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d16445]"
                    href="/dashboard/new"
                  >
                    {allCoursesCompleted ? "+ Create new goal" : "+ Create learning goal"} <ArrowUpRight aria-hidden="true" size={16} />
                  </Link>
                )}
              </section>

              {/* Course Cards List */}
              <div>
                <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">Your learning goals</h2>
                    <p className="mt-1 text-sm text-[#68736d]">
                      {courseCards.length} {courseCards.length === 1 ? "course" : "courses"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className="inline-flex min-h-10 items-center gap-2 rounded-md border border-[#d9ddd5] bg-white px-3 py-2 text-sm font-semibold text-[#1b302b] hover:border-[#1b6657] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:opacity-60"
                      disabled={courseListLoading || progressLoading}
                      onClick={handleRefresh}
                      title="Refresh courses and progress"
                      type="button"
                    >
                      <RefreshCcw aria-hidden="true" className={courseListLoading || progressLoading ? "animate-spin" : ""} size={15} />
                      <span>Refresh</span>
                    </button>
                    <Link
                      className="rounded-md bg-[#d16445] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#b84f34] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d16445]"
                      href="/dashboard/new"
                    >
                      + New learning goal
                    </Link>
                  </div>
                </div>

                {courseCards.length > 0 ? (
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {courseCards.map((course) => {
                      const visual = courseCardVisual(course.title);
                      const status = courseCardStatus(course);
                      const Icon = visual.Icon;

                      return (
                        <Link
                          className="group flex flex-col justify-between rounded-lg border border-[#e0e2d9] bg-white p-5 transition hover:-translate-y-0.5 hover:border-[#b8c1b8] hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]"
                          href={`/dashboard/courses/${course.courseId}`}
                          key={course.courseId}
                        >
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <span className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold ${visual.tone}`}>
                                <Icon aria-hidden="true" size={14} />
                                <span>Course</span>
                              </span>
                              <span className={`rounded px-2 py-0.5 text-[0.7rem] font-semibold ${status.tone}`}>
                                {status.label}
                              </span>
                            </div>

                            <h3 className="mt-3 break-words text-xl font-semibold leading-7 group-hover:text-[#b84f34]">
                              {course.title}
                            </h3>

                            {course.goal?.goalText && (
                              <p className="mt-2 line-clamp-2 text-sm leading-6 text-[#68736d]">
                                {course.goal.goalText}
                              </p>
                            )}

                            {/* Accurate Progress Bar */}
                            <div className="mt-4">
                              {course.totalLessons > 0 ? (
                                <div>
                                  <div className="flex items-center justify-between text-xs text-[#68736d]">
                                    <span>{course.completedLessons} of {course.totalLessons} lessons</span>
                                    <span className="font-semibold text-[#19352d]">{course.completionRate}%</span>
                                  </div>
                                  <progress
                                    aria-label={`${course.title}: ${course.completedLessons} of ${course.totalLessons} lessons completed`}
                                    className="mt-2 block h-2 w-full accent-[#176b59]"
                                    max={100}
                                    value={course.completionRate}
                                  />
                                </div>
                              ) : (
                                <p className="text-xs text-[#78847c]">
                                  {course.syllabusStatus === "generating"
                                    ? "Preparing syllabus..."
                                    : course.syllabusStatus === "failed"
                                    ? "Syllabus generation needed"
                                    : "Syllabus not generated yet"}
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="mt-5 flex items-center justify-between border-t border-[#edf0e9] pt-4 text-xs text-[#68736d]">
                            <span>
                              {course.goal?.skillLevel
                                ? `${course.goal.skillLevel} level`
                                : course.lastStudiedAt
                                ? `Active ${new Date(course.lastStudiedAt).toLocaleDateString()}`
                                : "Goal saved"}
                            </span>
                            <span className="font-semibold text-[#1b302b] group-hover:text-[#b84f34]">
                              {course.status === "completed"
                                ? "Review course →"
                                : course.status === "in_progress"
                                ? "Continue →"
                                : "Open course →"}
                            </span>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                ) : (
                  <section className="rounded-lg border border-[#e0e2d9] bg-white p-7">
                    <h3 className="text-lg font-semibold">Your first course starts with a goal</h3>
                    <p className="mt-2 text-sm leading-6 text-[#68736d]">Add a subject and a little context to set up your learning space.</p>
                    <Link
                      className="mt-4 inline-flex rounded-md bg-[#1b302b] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#28473f]"
                      href="/dashboard/new"
                    >
                      Create a course
                    </Link>
                  </section>
                )}
              </div>
            </div>
          ) : section === "Practice" ? (
            /* PRACTICE SECTION */
            <PracticeCenter />
          ) : section === "Notes" ? (
            /* NOTES SECTION */
            <NotesLibrary />
          ) : (
            <section className="rounded-lg border border-[#e0e2d9] bg-white p-7 sm:p-9">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#d16445]">Coming next</p>
              <h2 className="mt-3 text-xl font-semibold">{section}</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-[#68736d]">
                This space is ready for your learning journey. Your goals and progress are already saved in your workspace.
              </p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
