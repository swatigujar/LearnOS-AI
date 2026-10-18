"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  BookOpen,
  Braces,
  ChartNoAxesCombined,
  ChevronDown,
  CircleUserRound,
  Coffee,
  Dumbbell,
  FileCode,
  NotebookPen,
  PanelsTopLeft,
  RefreshCcw,
  Sparkles,
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
const sectionIcons = {
  Dashboard: PanelsTopLeft,
  Practice: Dumbbell,
  Notes: NotebookPen,
  "Progress / Mastery": ChartNoAxesCombined,
} satisfies Record<Section, LucideIcon>;

function courseCardVisual(title: string): { Icon: LucideIcon; tone: string; artworkTone: string } {
  const name = title.toLowerCase();
  if (/\bjava\b/.test(name)) return { Icon: Coffee, tone: "bg-[#FFF0E5] text-[#985233]", artworkTone: "from-[#FFCBAA]/70 via-[#FFF8F1] to-[#F2ECFF]" };
  if (/\bpython\b/.test(name)) return { Icon: Braces, tone: "bg-[#EAF4EC] text-[#477653]", artworkTone: "from-[#CBE5D0] via-[#F6FBF6] to-[#F8B4D0]/50" };
  if (/playwright/.test(name)) return { Icon: PanelsTopLeft, tone: "bg-[#EAF4EC] text-[#477653]", artworkTone: "from-[#C8E0CE] via-[#F8FBF8] to-[#FFF0E5]" };
  if (/typescript/.test(name)) return { Icon: FileCode, tone: "bg-[#F2ECFF] text-[#642BD8]", artworkTone: "from-[#DCCBFA] via-[#FAF7FF] to-[#F8B4D0]/50" };
  if (/javascript/.test(name)) return { Icon: Braces, tone: "bg-[#FFF3D9] text-[#85651E]", artworkTone: "from-[#F8E3A6] via-[#FFFAF0] to-[#F8B4D0]/45" };
  if (/\bapi\b/.test(name)) return { Icon: Webhook, tone: "bg-[#FCEAF1] text-[#9D4D76]", artworkTone: "from-[#F8B4D0]/65 via-[#FCF7FB] to-[#DCCBFA]" };
  return { Icon: BookOpen, tone: "bg-[#F2ECFF] text-[#642BD8]", artworkTone: "from-[#DCCBFA] via-[#FCF9FF] to-[#FFCBAA]/60" };
}

function courseCardStatus(course: CourseProgress) {
  if (course.status === "completed") return { label: "Completed", tone: "bg-[#e8f3e9] text-[#31553d]" };
  if (course.status === "in_progress") return { label: "In progress", tone: "bg-[#f5f1e5] text-[#725d27]" };
  if (course.syllabusStatus === "generating") return { label: "Preparing syllabus", tone: "bg-[#F2ECFF] text-[#642BD8]" };
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
  const ContinueCourseIcon = continueCourse ? courseCardVisual(continueCourse.title).Icon : BookOpen;
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
      <main className="flex min-h-screen items-center justify-center bg-[#FFF8F1] text-sm text-[#756B80]">
        Loading your learning space...
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-[#FFF8F1] text-[#29213D]">
      <header className="sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-[#EEE5E0]/80 bg-white/90 px-5 backdrop-blur-xl sm:px-8">
        <Link href="/" className="inline-flex items-center gap-2.5 text-lg font-bold tracking-tight text-[#29213D]">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#642BD8] text-white shadow-sm"><BookOpen aria-hidden="true" size={18} /></span>
          <span>LearnOS <span className="font-medium text-[#642BD8]">AI</span></span>
        </Link>
        <div className="relative" ref={accountMenu}>
          <button
            aria-controls="account-dropdown"
            aria-expanded={accountOpen}
            aria-label={`Account: ${profileName}`}
            className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-[#EEE5E0] bg-white px-3 py-2 text-sm font-semibold transition hover:border-[#C5B1F1] hover:bg-[#FCF9FF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]"
            onClick={() => setAccountOpen((open) => !open)}
            ref={accountButton}
            type="button"
          >
            <CircleUserRound aria-hidden="true" className="text-[#642BD8]" size={19} />
            <span className="max-w-36 truncate">{profileName}</span>
            <ChevronDown aria-hidden="true" className={`transition-transform ${accountOpen ? "rotate-180" : ""}`} size={15} />
          </button>
          <div
            className="absolute right-0 top-full z-30 mt-2 w-64 rounded-lg border border-[#EEE5E0] bg-white p-4 shadow-lg"
            hidden={!accountOpen}
            id="account-dropdown"
            role="group"
            aria-label="Account details"
          >
            <p className="break-words font-semibold text-[#29213D]">{profileName}</p>
            {user.email && <p className="mt-1 break-all text-sm text-[#756B80]">{user.email}</p>}
            <div className="mt-4 border-t border-[#EEE5E0] pt-3">
              <button
                className="w-full rounded-md px-3 py-2 text-left text-sm font-semibold text-[#9b3b2b] transition hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]"
                onClick={() => void handleSignOut()}
                type="button"
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1440px] gap-6 px-4 py-5 sm:px-7 lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-10 lg:px-10 lg:py-9">
        <aside className="lg:sticky lg:top-[96px] lg:h-fit">
          <nav aria-label="Dashboard sections" className="mb-1 flex gap-2 overflow-x-auto pb-2 lg:hidden">
            {sections.map((item) => {
              const Icon = sectionIcons[item];
              return <button aria-current={section === item ? "page" : undefined} className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-xl border px-3 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8] ${section === item ? "border-[#ddd9fa] bg-[#F2ECFF] text-[#5322B5]" : "border-[#EEE5E0] bg-white text-[#756B80]"}`} key={item} onClick={() => setSection(item)} type="button"><Icon aria-hidden="true" size={15} />{item === "Progress / Mastery" ? "Progress" : item}</button>;
            })}
          </nav>
          <div className="hidden rounded-2xl border border-[#EEE5E0] bg-white p-3 shadow-[0_12px_35px_-28px_rgba(36,34,70,0.45)] lg:block">
            <p className="px-3 pb-3 pt-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#89879c]">Learning space</p>
          <nav aria-label="Dashboard sections" className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            {sections.map((item) => (
              <button
                aria-current={section === item ? "page" : undefined}
                className={`group flex shrink-0 items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8] ${
                  section === item ? "bg-[#F2ECFF] font-semibold text-[#5322B5]" : "text-[#756B80] hover:bg-[#FFF8F1] hover:text-[#29213D]"
                }`}
                key={item}
                onClick={() => setSection(item)}
                type="button"
              >
                {(() => { const Icon = sectionIcons[item]; return <Icon aria-hidden="true" className={section === item ? "text-[#642BD8]" : "text-[#89879c] group-hover:text-[#642BD8]"} size={17} />; })()}
                <span>{item}</span>
                {item === "Progress / Mastery" && <span className="ml-auto rounded-full bg-[#F2ECFF] px-2 py-0.5 text-[9px] font-semibold text-[#642BD8]">Preview</span>}
              </button>
            ))}
          </nav>
          </div>
        </aside>

        <main className="min-w-0">
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
            <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-[#642BD8]">Your learning studio</p>
            <h1 className="text-3xl font-bold tracking-[-0.035em] text-[#29213D] sm:text-[2.15rem]">
              {section === "Dashboard" ? `Welcome, ${profileName.split(" ")[0]}` : section}
            </h1>
            {section === "Dashboard" && <p className="mt-2 text-sm text-[#756B80]">Pick up where you left off and keep your learning momentum going.</p>}
            </div>
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
          <section className="relative isolate grid gap-5 overflow-hidden rounded-[1.5rem] border border-[#E7DDF8] bg-[linear-gradient(118deg,#F2ECFF_0%,#FFFDFB_52%,#FCEAF1_100%)] p-5 shadow-[0_22px_65px_-48px_rgba(74,40,95,0.32)] sm:grid-cols-[minmax(0,1fr)_290px] sm:items-center sm:p-8">
                <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-16 -z-10 h-56 w-56 rounded-full bg-[#F8B4D0]/30 blur-3xl" />
                <div className="min-w-0">
                  <p className="inline-flex items-center gap-1.5 rounded-full border border-[#E7DDF8] bg-white/75 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#642BD8]"><Sparkles aria-hidden="true" size={13} /> Your next step</p>
                  {progressLoading && !progressSummary ? (
                    <div className="mt-3 h-6 w-48 animate-pulse rounded bg-[#eef1ed]" />
                  ) : continueCourse ? (
                    <>
                      <h2 className="mt-3 break-words text-2xl font-bold tracking-tight text-[#4A285F] sm:text-[1.8rem]">
                        {continueCourse.currentLesson ? "Continue your lesson" : continueCourse.nextLesson ? "Today's focus" : "Continue your course"}
                      </h2>
                      <p className="mt-2 break-words text-sm leading-6 text-[#756B80]">
                        {continueCourse.title}
                        {continueCourse.currentLesson || continueCourse.nextLesson ? ` · ${continueCourse.currentLesson ?? continueCourse.nextLesson}` : ""}
                      </p>
                      {continueCourse.totalLessons > 0 ? (
                        <div className="mt-4 max-w-lg">
                          <div className="mb-1.5 flex items-center justify-between text-xs">
                            <span className="text-[#756B80]">Course progress</span>
                            <span className="font-semibold text-[#4A285F]">{continueCourse.completedLessons} / {continueCourse.totalLessons} lessons ({continueCourse.completionRate}%)</span>
                          </div>
                          <progress
                            aria-label={`${continueCourse.title}: ${continueCourse.completedLessons} of ${continueCourse.totalLessons} lessons complete`}
                            className="block h-2 w-full accent-[#642BD8]"
                            max={100}
                            value={continueCourse.completionRate}
                          />
                        </div>
                      ) : (
                        <p className="mt-3 text-xs text-[#756B80]">
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
                      <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#4A285F]">Your learning focus</h2>
                      <p className="mt-1 text-sm text-[#756B80]">Progress is unavailable right now; retry to load your saved course activity.</p>
                      <button
                        className="mt-2 text-xs font-semibold text-[#642BD8] underline underline-offset-2"
                        disabled={progressLoading}
                        onClick={() => void progressLoader?.()}
                        type="button"
                      >
                        Retry progress
                      </button>
                    </>
                  ) : allCoursesCompleted ? (
                    <>
                      <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#4A285F]">All courses completed!</h2>
                      <p className="mt-1 text-sm text-[#756B80]">Great work! Start a new learning goal when you are ready for the next subject.</p>
                    </>
                  ) : courseCards.length > 0 ? (
                    <>
                      <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#4A285F]">Choose a course to continue</h2>
                      <p className="mt-1 text-sm text-[#756B80]">Pick a course below to view the syllabus and continue learning with your AI tutor.</p>
                    </>
                  ) : (
                    <>
                      <h2 className="mt-2 text-xl font-semibold tracking-tight text-[#4A285F]">Start with a learning goal</h2>
                      <p className="mt-1 text-sm text-[#756B80]">Your next lesson and progress will appear here once a course and syllabus are saved.</p>
                    </>
                  )}
                </div>

                {continueCourse ? (
                  <Link
                    className="group relative flex min-h-[176px] flex-col justify-between overflow-hidden rounded-2xl border border-white/90 bg-white/85 p-4 text-left shadow-[0_14px_35px_-28px_rgba(74,40,95,0.38)] backdrop-blur-sm transition hover:-translate-y-1 hover:border-[#C5B1F1] hover:bg-white hover:shadow-[0_22px_42px_-28px_rgba(74,40,95,0.28)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]"
                    href={`/dashboard/courses/${continueCourse.courseId}`}
                  >
                    <span aria-hidden="true" className="absolute -right-5 -top-7 h-28 w-28 rounded-full bg-[#F2ECFF] transition-transform duration-300 group-hover:scale-125" />
                    <span className="relative flex items-center justify-between">
                      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#642BD8] text-white shadow-[0_10px_24px_-14px_rgba(81,68,198,0.8)]"><ContinueCourseIcon aria-hidden="true" size={23} /></span>
                      <span className="rounded-full border border-[#e5e1f9] bg-white/90 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[#642BD8]">Continue</span>
                    </span>
                    <span className="relative min-w-0">
                      <span className="block text-[10px] font-bold uppercase tracking-[0.14em] text-[#858398]">Your course</span>
                      <span className="mt-1 block truncate text-sm font-bold text-[#4A285F]">{continueCourse.title}</span>
                      <span className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-[#642BD8]">Continue learning <ArrowUpRight aria-hidden="true" className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" size={14} /></span>
                    </span>
                  </Link>
                ) : courseCards.length > 0 && !allCoursesCompleted ? (
                  <Link
                    className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-[#E2D6ED] bg-white px-4 py-3 text-sm font-semibold text-[#642BD8] transition hover:border-[#C5B1F1] hover:bg-[#FCF9FF]"
                    href={`/dashboard/courses/${courseCards.find((c) => c.status !== "completed")?.courseId ?? courseCards[0].courseId}`}
                  >
                    Open course <ArrowUpRight aria-hidden="true" size={16} />
                  </Link>
                ) : (
                  <Link
                    className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#642BD8] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-[#5322B5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]"
                    href="/dashboard/new"
                  >
                    {allCoursesCompleted ? "+ Create new goal" : "+ Create learning goal"} <ArrowUpRight aria-hidden="true" size={16} />
                  </Link>
                )}
              </section>

              {progressSummary && (
                <section aria-label="Course progress overview" className="grid gap-3 sm:grid-cols-3">
                  {[
                    { label: "Overall course completion", value: `${progressSummary.overallProgress}%`, detail: "Based on completed course lessons" },
                    { label: "Courses in progress", value: String(progressSummary.coursesInProgress), detail: "Your active learning goals" },
                    { label: "Completed courses", value: String(progressSummary.completedCourses), detail: `of ${progressSummary.totalCourses} total courses` },
                  ].map((item, index) => (
                    <article className="rounded-2xl border border-[#EEE5E0] bg-white px-4 py-4 shadow-[0_12px_32px_-30px_rgba(36,34,70,0.45)] sm:px-5" key={item.label}>
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-xs font-semibold leading-5 text-[#756B80]">{item.label}</p>
                        <span aria-hidden="true" className={`mt-0.5 h-2 w-2 rounded-full ${index === 0 ? "bg-[#642BD8]" : index === 1 ? "bg-[#a58ce9]" : "bg-[#c7b5f3]"}`} />
                      </div>
                      <p className="mt-2 text-2xl font-bold tracking-tight text-[#29213D]">{item.value}</p>
                      <p className="mt-1 text-[11px] text-[#858398]">{item.detail}</p>
                    </article>
                  ))}
                </section>
              )}

              {/* Course Cards List */}
              <div>
                <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">Your learning goals</h2>
                    <p className="mt-1 text-sm text-[#756B80]">
                      {courseCards.length} {courseCards.length === 1 ? "course" : "courses"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      className="inline-flex min-h-10 items-center gap-2 rounded-md border border-[#EEE5E0] bg-white px-3 py-2 text-sm font-semibold text-[#29213D] hover:border-[#642BD8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8] disabled:opacity-60"
                      disabled={courseListLoading || progressLoading}
                      onClick={handleRefresh}
                      title="Refresh courses and progress"
                      type="button"
                    >
                      <RefreshCcw aria-hidden="true" className={courseListLoading || progressLoading ? "animate-spin" : ""} size={15} />
                      <span>Refresh</span>
                    </button>
                    <Link
                      className="rounded-xl bg-[#642BD8] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#5322B5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]"
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
                          className="group flex flex-col justify-between rounded-2xl border border-[#EEE5E0] bg-white p-5 shadow-[0_12px_32px_-28px_rgba(36,34,70,0.42)] transition hover:-translate-y-1 hover:border-[#D9C9EB] hover:shadow-[0_22px_42px_-30px_rgba(81,68,198,0.35)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]"
                          href={`/dashboard/courses/${course.courseId}`}
                          key={course.courseId}
                        >
                          <div>
                            <div aria-hidden="true" className={`relative isolate mb-5 flex h-32 items-end justify-between overflow-hidden rounded-xl border border-white/70 bg-gradient-to-br ${visual.artworkTone} p-4`}>
                              <div className="absolute inset-0 -z-10 opacity-60 [background-image:radial-gradient(#9a8cda_0.7px,transparent_0.7px)] [background-size:14px_14px] [mask-image:linear-gradient(125deg,transparent,black)]" />
                              <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/80 bg-white/80 text-[#642BD8] shadow-[0_12px_28px_-18px_rgba(57,48,135,0.55)] backdrop-blur-sm"><Icon size={27} strokeWidth={1.8} /></span>
                              <Icon className="absolute -right-2 -top-5 -z-10 rotate-[-12deg] text-[#642BD8]/10" size={126} strokeWidth={1.1} />
                              <span className="rounded-full border border-white/75 bg-white/70 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.12em] text-[#514e69] backdrop-blur-sm">Learning path</span>
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <span className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold ${visual.tone}`}>
                                <Icon aria-hidden="true" size={14} />
                                <span>Course</span>
                              </span>
                              <span className={`rounded px-2 py-0.5 text-[0.7rem] font-semibold ${status.tone}`}>
                                {status.label}
                              </span>
                            </div>

                            <h3 className="mt-3 break-words text-xl font-bold leading-7 tracking-tight text-[#29213D] group-hover:text-[#642BD8] sm:text-[1.35rem]">
                              {course.title}
                            </h3>

                            {course.goal?.goalText && (
                              <p className="mt-2 line-clamp-2 text-sm leading-6 text-[#756B80]">
                                {course.goal.goalText}
                              </p>
                            )}

                            {/* Accurate Progress Bar */}
                            <div className="mt-4">
                              {course.totalLessons > 0 ? (
                                <div>
                                  <div className="flex items-center justify-between gap-3 text-xs text-[#756B80]">
                                    <span>{course.completedLessons} of {course.totalLessons} topics completed</span>
                                    <span className="shrink-0 font-bold text-[#4A285F]">{course.completionRate}%</span>
                                  </div>
                                  <progress
                                    aria-label={`${course.title}: ${course.completedLessons} of ${course.totalLessons} topics completed`}
                                    className="mt-2 block h-2 w-full accent-[#642BD8]"
                                    max={100}
                                    value={course.completionRate}
                                  />
                                  <p className="mt-2 text-[11px] font-medium text-[#858398]">{course.remainingLessons} {course.remainingLessons === 1 ? "topic" : "topics"} remaining</p>
                                </div>
                              ) : (
                                <p className="text-xs text-[#756B80]">
                                  {course.syllabusStatus === "generating"
                                    ? "Preparing syllabus..."
                                    : course.syllabusStatus === "failed"
                                    ? "Syllabus generation needed"
                                    : "Syllabus not generated yet"}
                                </p>
                              )}
                            </div>
                          </div>

                          <div className="mt-5 flex items-center justify-between border-t border-[#EEE5E0] pt-4 text-xs text-[#756B80]">
                            <span>
                              {course.goal?.skillLevel
                                ? `${course.goal.skillLevel} level`
                                : course.lastStudiedAt
                                ? `Active ${new Date(course.lastStudiedAt).toLocaleDateString()}`
                                : "Goal saved"}
                            </span>
                            <span className="font-semibold text-[#29213D] group-hover:text-[#5322B5]">
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
                  <section className="rounded-lg border border-[#EEE5E0] bg-white p-7">
                    <h3 className="text-lg font-semibold">Your first course starts with a goal</h3>
                    <p className="mt-2 text-sm leading-6 text-[#756B80]">Add a subject and a little context to set up your learning space.</p>
                    <Link
                      className="mt-4 inline-flex rounded-md bg-[#29213D] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#5322B5]"
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
            <section aria-labelledby="progress-heading" className="space-y-6">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="learnos-eyebrow">Your course learning</p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[#29213D]" id="progress-heading">Progress / Mastery</h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-[#756B80]">This overview reflects saved lesson completion. Practice attempts are kept separate and do not change course completion.</p>
                </div>
                <button className="learnos-secondary-button inline-flex min-h-10 items-center gap-2 px-3 py-2 text-sm" disabled={progressLoading} onClick={() => void progressLoader?.()} type="button"><RefreshCcw aria-hidden="true" className={progressLoading ? "animate-spin" : ""} size={15} />Refresh</button>
              </div>

              {progressError && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{progressError}</p>}

              {progressLoading && !progressSummary ? (
                <div aria-label="Loading course progress" className="grid gap-3 sm:grid-cols-3" role="status">
                  {[0, 1, 2].map((item) => <div className="h-28 animate-pulse rounded-2xl border border-[#EEE5E0] bg-white" key={item} />)}
                </div>
              ) : progressSummary ? (
                <>
                  <div aria-label="Course completion summary" className="grid gap-3 sm:grid-cols-3">
                    {[
                      { label: "Overall completion", value: `${progressSummary.overallProgress}%`, detail: "Completed lessons across courses", icon: ChartNoAxesCombined, tone: "bg-[#F2ECFF] text-[#642BD8]" },
                      { label: "Courses in progress", value: String(progressSummary.coursesInProgress), detail: "Active learning goals", icon: BookOpen, tone: "bg-[#FFF0E5] text-[#A65E37]" },
                      { label: "Completed courses", value: String(progressSummary.completedCourses), detail: `of ${progressSummary.totalCourses} saved courses`, icon: Sparkles, tone: "bg-[#EAF4EC] text-[#477653]" },
                    ].map(({ label, value, detail, icon: Icon, tone }) => (
                      <article className="learnos-card p-5" key={label}>
                        <div className="flex items-center justify-between gap-3"><p className="text-sm font-medium text-[#756B80]">{label}</p><span className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone}`}><Icon aria-hidden="true" size={18} /></span></div>
                        <p className="mt-3 text-3xl font-semibold tracking-tight text-[#29213D]">{value}</p>
                        <p className="mt-1 text-xs text-[#756B80]">{detail}</p>
                      </article>
                    ))}
                  </div>

                  <section aria-labelledby="course-progress-heading" className="learnos-card overflow-hidden">
                    <div className="border-b border-[#EEE5E0] px-5 py-4 sm:px-6"><h3 className="font-semibold text-[#29213D]" id="course-progress-heading">Course progress</h3><p className="mt-1 text-sm text-[#756B80]">Lesson counts and percentages come from your saved syllabus and completion state.</p></div>
                    {progressSummary.courses.length ? <ul className="divide-y divide-[#EEE5E0]">
                      {progressSummary.courses.map((course) => (
                        <li className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6" key={course.courseId}>
                          <div className="min-w-0 flex-1">
                            <Link className="break-words font-semibold text-[#29213D] underline-offset-4 hover:text-[#642BD8] hover:underline" href={`/dashboard/courses/${course.courseId}`}>{course.title}</Link>
                            {course.totalLessons > 0 ? <>
                              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-[#756B80]"><span>{course.completedLessons} of {course.totalLessons} topics completed</span><span className="font-semibold text-[#4A285F]">{course.remainingLessons} remaining · {course.completionRate}%</span></div>
                              <progress aria-label={`${course.title}: ${course.completedLessons} of ${course.totalLessons} topics completed`} className="mt-2 block h-2 w-full accent-[#642BD8]" max={100} value={course.completionRate} />
                            </> : <p className="mt-2 text-xs text-[#756B80]">{course.syllabusStatus === "failed" ? "Syllabus needs attention" : course.syllabusStatus === "generating" ? "Syllabus is being prepared" : "No saved topics to report yet"}</p>}
                          </div>
                          <span className="w-fit shrink-0 rounded-full bg-[#F2ECFF] px-3 py-1 text-xs font-semibold text-[#642BD8]">{course.status === "completed" ? "Completed" : course.status === "in_progress" ? "In progress" : "Not started"}</span>
                        </li>
                      ))}
                    </ul> : <div className="px-5 py-8 text-center sm:px-6"><p className="font-medium text-[#29213D]">No saved courses yet</p><p className="mt-1 text-sm text-[#756B80]">Create a learning goal to start a course and track lesson completion.</p><Link className="learnos-primary-button mt-4 inline-flex min-h-10 items-center px-4 py-2 text-sm" href="/dashboard/new">Create a learning goal</Link></div>}
                  </section>
                </>
              ) : !progressError ? (
                <div className="learnos-card px-5 py-10 text-center">
                  <p className="font-medium text-[#29213D]">Course progress is not available yet</p>
                  <p className="mt-1 text-sm text-[#756B80]">Saved lesson completion will appear here when the progress service is available.</p>
                </div>
              ) : null}

              <aside className="flex flex-col gap-4 rounded-2xl border border-[#E7DDF8] bg-[linear-gradient(120deg,#F2ECFF,#FFFDFB_60%,#FCEAF1)] p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <div className="flex items-start gap-3"><span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-[#642BD8]"><NotebookPen aria-hidden="true" size={18} /></span><div><h3 className="font-semibold text-[#29213D]">Practice activity lives in its own space</h3><p className="mt-1 max-w-2xl text-sm leading-6 text-[#756B80]">Saved practice results are available in Practice. They remain separate from course lesson completion.</p></div></div>
                <button className="learnos-secondary-button inline-flex min-h-10 shrink-0 items-center justify-center gap-2 px-4 py-2 text-sm" onClick={() => setSection("Practice")} type="button"><Dumbbell aria-hidden="true" size={16} />Open Practice</button>
              </aside>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
