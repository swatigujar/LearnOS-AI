"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  RefreshCcw,
  Trash2,
  X,
} from "lucide-react";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { CourseProgress } from "@/lib/progress";
import {
  chooseRecommendedLesson,
  createPlannerSession,
  dateKeyInTimeZone,
  FALLBACK_TIME_ZONE,
  deletePlannerSession,
  fetchPlannerOverview,
  getLocalTimeZone,
  localDateKey,
  moveCalendarDate,
  updatePlannerSession,
  updatePlannerSessionStatus,
  validateSessionDraft,
  visibleCalendarDates,
  type CalendarView,
  type PlannerOverview,
  type PlannerSession,
  type SessionDraft,
} from "@/lib/study-planner";

const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function useDetectedTimeZone() {
  const [result, setResult] = useState<{ ready: boolean; value: string | null }>({ ready: false, value: null });
  useEffect(() => {
    const timer = window.setTimeout(() => setResult({ ready: true, value: getLocalTimeZone() }), 0);
    return () => window.clearTimeout(timer);
  }, []);
  return result;
}

function displayDate(date: Date, options: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", year: "numeric" }) {
  return date.toLocaleDateString(undefined, options);
}

function localTimeValue(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function makeInitialDraft(date: Date, data: PlannerOverview | null): SessionDraft {
  const now = new Date();
  const defaultStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 9, 0);
  if (localDateKey(date) === localDateKey(now)) {
    defaultStart.setTime(now.getTime() + 60 * 60_000);
    defaultStart.setMinutes(Math.ceil(defaultStart.getMinutes() / 15) * 15, 0, 0);
  }
  const course = data?.courses[0];
  return {
    courseId: course?.courseId ?? "",
    lessonId: "",
    date: localDateKey(defaultStart),
    time: localTimeValue(defaultStart),
    durationMinutes: 45,
    note: "",
  };
}

function sessionDraftFromRecord(session: PlannerSession, timeZone: string): SessionDraft {
  const start = new Date(session.startAt);
  const localTime = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(start);
  return {
    courseId: session.courseId,
    lessonId: session.lessonId ?? "",
    date: dateKeyInTimeZone(start, timeZone),
    time: localTime,
    durationMinutes: session.durationMinutes,
    note: session.note,
  };
}

function sessionStatusLabel(status: PlannerSession["status"]) {
  if (status === "completed") return "Attended";
  if (status === "cancelled") return "Cancelled";
  return "Planned";
}

export function LearningInsights({ courses }: { courses: CourseProgress[] }) {
  const { user } = useAuth();
  const timeZoneResult = useDetectedTimeZone();
  const timeZone = timeZoneResult.value;
  const effectiveTimeZone = timeZone ?? FALLBACK_TIME_ZONE;
  const requestKey = `${user?.uid ?? "signed-out"}:${effectiveTimeZone}`;
  const [result, setResult] = useState<{ userId: string; requestKey: string; value: PlannerOverview | null; error: string } | null>(null);
  const currentResult = result?.requestKey === requestKey && result.userId === user?.uid ? result : null;
  const data = currentResult?.value ?? null;
  const loading = !!user && !currentResult;
  const error = currentResult?.error ?? "";

  useEffect(() => {
    if (!user || !timeZoneResult.ready) return;
    const currentUser = user;
    const currentRequestKey = requestKey;
    let active = true;
    void currentUser.getIdToken()
      .then((token) => fetchPlannerOverview(token, new Date(), "week", effectiveTimeZone))
      .then((overview) => {
        if (active && auth.currentUser?.uid === currentUser.uid) {
          setResult({ userId: currentUser.uid, requestKey: currentRequestKey, value: overview, error: "" });
        }
      })
      .catch((failure: unknown) => {
        if (active && auth.currentUser?.uid === currentUser.uid) {
          setResult({
            userId: currentUser.uid,
            requestKey: currentRequestKey,
            value: null,
            error: failure instanceof Error ? failure.message : "Learning insights could not be loaded.",
          });
        }
      });
    return () => { active = false; };
  }, [requestKey, effectiveTimeZone, timeZoneResult.ready, user]);

  const mostCompletedCourse = [...courses].filter((course) => course.totalLessons > 0)
    .sort((first, second) => second.completedLessons - first.completedLessons)[0];
  const recommended = data ? chooseRecommendedLesson(data.courses) : null;

  return (
    <section aria-label="Learning insights">
      <article className="rounded-lg border border-[#dce3db] bg-white p-4 shadow-sm sm:p-5">
        <p className="text-[0.68rem] font-bold uppercase tracking-[0.1em] text-[#c35d42]">Learning insights</p>
        {mostCompletedCourse && mostCompletedCourse.completedLessons > 0 ? <div className="mt-2">
          <p className="text-xs text-[#68736d]">Most completed lessons</p>
          <p className="mt-0.5 font-semibold text-[#19352d]">{mostCompletedCourse.title}</p>
          <p className="text-xs text-[#68736d]">{mostCompletedCourse.completedLessons} of {mostCompletedCourse.totalLessons} lessons</p>
        </div> : <p className="mt-2 text-sm leading-5 text-[#68736d]">Course insights will appear after lesson completions are recorded.</p>}
        {loading && <div aria-label="Loading learning insights" className="mt-3 h-10 animate-pulse rounded-md bg-[#f0f4ef]" role="status" />}
        {error && <p className="mt-3 text-xs text-[#68736d]" role="status">Recent activity and recommendations are unavailable right now.</p>}
        {data?.completions.length ? <div className="mt-3 border-t border-[#e8ede8] pt-3">
          <h4 className="text-xs font-semibold text-[#52645b]">Recently completed</h4>
          <ul className="mt-2 space-y-2">
            {data.completions.slice(-3).reverse().map((completion) => <li className="flex min-w-0 justify-between gap-2 text-xs" key={completion.eventId}><span className="min-w-0 truncate text-[#31463b]">{completion.lessonTitle} <span className="text-[#879189]">· {completion.courseTitle}</span></span><time className="shrink-0 text-[#879189]" dateTime={completion.completedAt}>{new Date(completion.completedAt).toLocaleDateString()}</time></li>)}
          </ul>
        </div> : data && <p className="mt-3 border-t border-[#e8ede8] pt-3 text-xs text-[#879189]">No recent lesson completions are recorded.</p>}
        {recommended && <div className="mt-3 border-t border-[#e8ede8] pt-3">
          <p className="text-xs text-[#68736d]">Recommended next lesson</p>
          <p className="mt-0.5 truncate text-sm font-semibold text-[#19352d]">{recommended.lesson.title} <span className="font-normal text-[#68736d]">· {recommended.course.title}</span></p>
          <Link className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#176b59] hover:underline" href={`/dashboard/courses/${recommended.course.courseId}?topicId=${encodeURIComponent(recommended.lesson.lessonId)}`}>Open lesson <ArrowUpRight aria-hidden="true" size={13} /></Link>
        </div>}
      </article>
    </section>
  );
}

export function StudyPlanner() {
  const { user } = useAuth();
  const [view, setView] = useState<CalendarView>("month");
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [plannerResult, setPlannerResult] = useState<{ userId: string; requestKey: string; value: PlannerOverview | null; error: string } | null>(null);
  const [actionError, setActionError] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [notice, setNotice] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SessionDraft>(() => makeInitialDraft(new Date(), null));
  const [saving, setSaving] = useState(false);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);

  const timeZoneResult = useDetectedTimeZone();
  const timeZone = timeZoneResult.value;
  const effectiveTimeZone = timeZone ?? FALLBACK_TIME_ZONE;
  const requestKey = `${user?.uid ?? "signed-out"}:${localDateKey(selectedDate)}:${view}:${effectiveTimeZone}:${reloadKey}`;
  const currentPlannerResult = plannerResult?.requestKey === requestKey && plannerResult.userId === user?.uid ? plannerResult : null;
  const data = currentPlannerResult?.value ?? null;
  const loading = !!user && !currentPlannerResult;
  const error = currentPlannerResult?.error || actionError;
  const calendarDates = visibleCalendarDates(view, selectedDate);
  const selectedDateKey = localDateKey(selectedDate);
  const recommended = data ? chooseRecommendedLesson(data.courses) : null;

  function retryPlannerLoad() {
    setActionError("");
    setReloadKey((current) => current + 1);
  }

  useEffect(() => {
    if (!user || !timeZoneResult.ready) return;
    const currentUser = user;
    const currentRequestKey = requestKey;
    let active = true;
    void currentUser.getIdToken()
      .then((token) => fetchPlannerOverview(token, selectedDate, view, effectiveTimeZone))
      .then((overview) => {
        if (!active || auth.currentUser?.uid !== currentUser.uid) return;
        setPlannerResult({ userId: currentUser.uid, requestKey: currentRequestKey, value: overview, error: "" });
      })
      .catch((failure: unknown) => {
        if (active && auth.currentUser?.uid === currentUser.uid) {
          setPlannerResult({
            userId: currentUser.uid,
            requestKey: currentRequestKey,
            value: null,
            error: failure instanceof Error ? failure.message : "The study planner could not be loaded.",
          });
        }
      });
    return () => { active = false; };
  }, [requestKey, selectedDate, effectiveTimeZone, timeZoneResult.ready, user, view]);

  function openNewSession() {
    setDraft(makeInitialDraft(selectedDate, data));
    setEditingSessionId(null);
    setSessionError("");
    setDialogOpen(true);
  }

  function openEditSession(session: PlannerSession) {
    setDraft(sessionDraftFromRecord(session, effectiveTimeZone));
    setEditingSessionId(session.sessionId);
    setSessionError("");
    setDialogOpen(true);
  }

  async function submitSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    const validation = validateSessionDraft(draft, new Date(), effectiveTimeZone);
    if (validation.error) {
      setSessionError(validation.error);
      return;
    }
    setSaving(true);
    setSessionError("");
    try {
      const token = await user.getIdToken();
      if (editingSessionId) await updatePlannerSession(token, editingSessionId, draft);
      else await createPlannerSession(token, draft);
      setNotice(editingSessionId ? "Study session updated." : "Study session scheduled.");
      setDialogOpen(false);
      setReloadKey((current) => current + 1);
    } catch (failure) {
      setSessionError(failure instanceof Error ? failure.message : "The study session could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function changeSessionStatus(session: PlannerSession, status: "completed" | "cancelled") {
    if (!user || busySessionId) return;
    setBusySessionId(session.sessionId);
    setActionError("");
    try {
      await updatePlannerSessionStatus(await user.getIdToken(), session.sessionId, status);
      setNotice(status === "completed" ? "Session marked attended. Lesson progress is unchanged." : "Session cancelled.");
      setReloadKey((current) => current + 1);
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "The session status could not be updated.");
    } finally {
      setBusySessionId(null);
    }
  }

  async function removeSession(session: PlannerSession) {
    if (!user || busySessionId) return;
    setBusySessionId(session.sessionId);
    setActionError("");
    try {
      await deletePlannerSession(await user.getIdToken(), session.sessionId);
      setNotice("Session removed from your planner.");
      setReloadKey((current) => current + 1);
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "The session could not be deleted.");
    } finally {
      setBusySessionId(null);
    }
  }

  const selectedSessions = (data?.sessions ?? []).filter((session) => dateKeyInTimeZone(session.startAt, effectiveTimeZone) === selectedDateKey);
  const selectedCompletions = (data?.completions ?? []).filter((completion) => dateKeyInTimeZone(completion.completedAt, effectiveTimeZone) === selectedDateKey);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="max-w-2xl text-sm leading-6 text-[#68736d]">Schedule study time, open the right lesson, and review recorded learning activity.</p>
        </div>
        <div className="flex gap-2">
          <button aria-label="Refresh planner" className="flex h-10 w-10 items-center justify-center rounded-md border border-[#d6dfd8] bg-white text-[#365c4e] hover:bg-[#f2f7f3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59] disabled:opacity-50" disabled={loading} onClick={retryPlannerLoad} title="Refresh planner" type="button"><RefreshCcw aria-hidden="true" size={17} /></button>
          <button className="inline-flex min-h-10 items-center gap-2 rounded-md bg-[#176b59] px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-[#125644] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59] disabled:cursor-not-allowed disabled:opacity-50" disabled={loading || !data?.courses.length} onClick={openNewSession} type="button"><Plus aria-hidden="true" size={17} />Schedule session</button>
        </div>
      </header>

      {timeZoneResult.ready && timeZone === null && <p className="rounded-md border border-[#eadfbd] bg-[#fff9e9] px-3 py-2 text-sm text-[#68551f]" role="status">Your browser time zone could not be detected. Dates are shown in UTC as a fallback.</p>}
      {notice && <p className="rounded-md border border-[#cddfd1] bg-[#eef6ef] px-3 py-2 text-sm text-[#31553d]" role="status">{notice}</p>}
      {error && <section className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert"><p>{error}</p><button className="mt-2 inline-flex items-center gap-1.5 font-semibold underline underline-offset-2" onClick={retryPlannerLoad} type="button"><RefreshCcw aria-hidden="true" size={14} />Retry</button></section>}
      {data && data.courses.length === 0 && <section className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#dce3db] bg-white px-4 py-3" role="status"><p className="text-sm text-[#68736d]">Create a course before scheduling a study session.</p><Link className="inline-flex min-h-9 items-center rounded-md bg-[#176b59] px-3 text-sm font-semibold text-white hover:bg-[#125644]" href="/dashboard/new">Create course</Link></section>}

      {loading && !data ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(17rem,0.7fr)]"><div className="h-[27rem] animate-pulse rounded-lg border border-[#dce3db] bg-white" /><div className="h-[27rem] animate-pulse rounded-lg border border-[#dce3db] bg-white" /></div>
      ) : data && (
        <>
          <section className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(19rem,0.9fr)] xl:gap-5">
            <div className="min-w-0 rounded-lg border border-[#dce3db] bg-white p-3 shadow-sm sm:p-4">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-1">
                  <button aria-label="Previous period" className="flex h-9 w-9 items-center justify-center rounded-md text-[#405b4f] hover:bg-[#f1f5f1] focus-visible:outline-2 focus-visible:outline-[#176b59]" onClick={() => setSelectedDate((current) => moveCalendarDate(current, view, -1))} type="button"><ChevronLeft aria-hidden="true" size={19} /></button>
                  <button aria-label="Next period" className="flex h-9 w-9 items-center justify-center rounded-md text-[#405b4f] hover:bg-[#f1f5f1] focus-visible:outline-2 focus-visible:outline-[#176b59]" onClick={() => setSelectedDate((current) => moveCalendarDate(current, view, 1))} type="button"><ChevronRight aria-hidden="true" size={19} /></button>
                  <h3 className="ml-1 min-w-0 break-words text-sm font-semibold text-[#19352d]">{view === "month" ? selectedDate.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: effectiveTimeZone }) : view === "week" ? `${displayDate(calendarDates[0], { month: "short", day: "numeric", timeZone: effectiveTimeZone })} – ${displayDate(calendarDates[6], { month: "short", day: "numeric", year: "numeric", timeZone: effectiveTimeZone })}` : displayDate(selectedDate, { weekday: "long", month: "long", day: "numeric", timeZone: effectiveTimeZone })}</h3>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button className="rounded-md border border-[#d6dfd8] px-2.5 py-1.5 text-xs font-semibold text-[#365c4e] hover:bg-[#f2f7f3] focus-visible:outline-2 focus-visible:outline-[#176b59]" onClick={() => setSelectedDate(new Date())} type="button">Today</button>
                  <div aria-label="Calendar view" className="inline-flex rounded-md border border-[#d6dfd8] p-0.5" role="group">
                    {(["month", "week", "day"] as const).map((option) => <button aria-pressed={view === option} className={`rounded px-2.5 py-1 text-xs font-semibold capitalize ${view === option ? "bg-[#e8f1e9] text-[#176b59]" : "text-[#68736d] hover:bg-[#f4f6f2]"}`} key={option} onClick={() => setView(option)} type="button">{option}</button>)}
                  </div>
                </div>
              </div>

              <div className={`grid ${view === "day" ? "grid-cols-1" : "grid-cols-7"} border-b border-[#e8ede8] pb-2 text-center text-[0.68rem] font-semibold text-[#738078]`}>
                {view === "day" ? <span>{selectedDate.toLocaleDateString(undefined, { weekday: "long", timeZone: effectiveTimeZone })}</span> : weekdayLabels.map((label) => <span key={label}>{label}</span>)}
              </div>
              <div aria-label={`${view} calendar`} className={`grid ${view === "day" ? "grid-cols-1" : "grid-cols-7"}`} role="grid">
                {calendarDates.map((date) => {
                  const dateKey = localDateKey(date);
                  const outsideMonth = view === "month" && date.getMonth() !== selectedDate.getMonth();
                  const daySessions = data.sessions.filter((session) => dateKeyInTimeZone(session.startAt, effectiveTimeZone) === dateKey);
                  const dayCompletions = data.completions.filter((completion) => dateKeyInTimeZone(completion.completedAt, effectiveTimeZone) === dateKey);
                  const isToday = dateKey === localDateKey(new Date());
                  const isSelected = dateKey === selectedDateKey;
                  return <button aria-label={`${displayDate(date)}${daySessions.length ? `, ${daySessions.length} scheduled sessions` : ""}${dayCompletions.length ? `, ${dayCompletions.length} completed lessons` : ""}`} aria-selected={isSelected} className={`relative flex min-h-[3.4rem] flex-col items-start border-b border-r border-[#edf0ec] p-1.5 text-left transition last:border-r-0 hover:bg-[#f5f8f4] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-[#176b59] sm:min-h-[4.5rem] sm:p-2 ${outsideMonth ? "text-[#a4aea7]" : "text-[#31463b]"} ${isSelected ? "bg-[#edf5ee]" : "bg-white"}`} key={dateKey} onClick={() => setSelectedDate(date)} role="gridcell" type="button">
                    <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${isToday ? "bg-[#176b59] font-semibold text-white" : ""}`}>{date.getDate()}</span>
                    <span aria-hidden="true" className="mt-auto flex gap-1 pt-1">
                      {daySessions.some((session) => session.status === "scheduled") && <i className="h-1.5 w-1.5 rounded-full bg-[#3576a1]" />}
                      {daySessions.some((session) => session.status === "completed") && <i className="h-1.5 w-1.5 rounded-full bg-[#176b59]" />}
                      {dayCompletions.length > 0 && <i className="h-1.5 w-1.5 rounded-full bg-[#4c8b5b]" />}
                      {daySessions.some((session) => session.status === "cancelled") && <i className="h-1.5 w-1.5 rounded-full bg-[#9ca7a0]" />}
                    </span>
                  </button>;
                })}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.68rem] text-[#68736d]">
                <span className="inline-flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-[#3576a1]" />Planned</span>
                <span className="inline-flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-[#176b59]" />Attended</span>
                <span className="inline-flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-[#4c8b5b]" />Lesson completed</span>
                <span className="inline-flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-[#9ca7a0]" />Cancelled</span>
              </div>
            </div>

            <aside aria-labelledby="selected-day-heading" className="min-w-0 rounded-lg border border-[#dce3db] bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3 border-b border-[#e8ede8] pb-3">
                <div>
                  <p className="text-[0.68rem] font-bold uppercase tracking-[0.1em] text-[#c35d42]">Selected day</p>
                  <h3 className="mt-1 text-base font-semibold text-[#19352d]" id="selected-day-heading">{displayDate(selectedDate, { weekday: "long", month: "long", day: "numeric", timeZone: effectiveTimeZone })}</h3>
                </div>
                <button aria-label="Schedule on selected day" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#eaf3eb] text-[#176b59] hover:bg-[#deebdf] focus-visible:outline-2 focus-visible:outline-[#176b59] disabled:opacity-50" disabled={!data.courses.length} onClick={openNewSession} title="Schedule on selected day" type="button"><Plus aria-hidden="true" size={18} /></button>
              </div>
              <div className="mt-3 max-h-[32rem] space-y-2 overflow-y-auto">
                {selectedSessions.map((session) => <article className="rounded-md border border-[#e3e9e3] p-3" key={session.sessionId}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-[#3576a1]">{sessionStatusLabel(session.status)}</p>
                      <h4 className="mt-1 break-words text-sm font-semibold text-[#19352d]">{session.lessonTitle || session.courseTitle}</h4>
                      <p className="mt-1 text-xs text-[#68736d]">{new Intl.DateTimeFormat(undefined, { timeZone: effectiveTimeZone, hour: "numeric", minute: "2-digit" }).format(new Date(session.startAt))} <span aria-hidden="true">·</span> {session.durationMinutes} min</p>
                      {session.lessonTitle && <p className="mt-0.5 text-xs text-[#68736d]">{session.courseTitle}</p>}
                    </div>
                    {session.status !== "completed" && <button aria-label={`Edit ${session.courseTitle} session`} className="flex h-8 w-8 items-center justify-center rounded-md text-[#617168] hover:bg-[#f1f5f1] focus-visible:outline-2 focus-visible:outline-[#176b59]" onClick={() => openEditSession(session)} title="Edit session" type="button"><Pencil aria-hidden="true" size={15} /></button>}
                  </div>
                  {session.note && <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-[#586761]">{session.note}</p>}
                  <Link className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#176b59] underline-offset-2 hover:underline" href={`/dashboard/courses/${session.courseId}`}>Open course <ArrowUpRight aria-hidden="true" size={12} /></Link>
                  {session.status === "scheduled" && <div className="mt-3 flex flex-wrap gap-2 border-t border-[#edf0ec] pt-2">
                    <button className="inline-flex items-center gap-1 rounded-md bg-[#eaf3eb] px-2.5 py-1.5 text-xs font-semibold text-[#31553d] disabled:opacity-50" disabled={busySessionId === session.sessionId} onClick={() => void changeSessionStatus(session, "completed")} type="button"><Check aria-hidden="true" size={13} />Mark attended</button>
                    <button className="rounded-md border border-[#e3e9e3] px-2.5 py-1.5 text-xs font-semibold text-[#68736d] disabled:opacity-50" disabled={busySessionId === session.sessionId} onClick={() => void changeSessionStatus(session, "cancelled")} type="button">Cancel</button>
                  </div>}
                  {session.status === "cancelled" && <button className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#8a5145] hover:underline disabled:opacity-50" disabled={busySessionId === session.sessionId} onClick={() => void removeSession(session)} type="button"><Trash2 aria-hidden="true" size={13} />Delete cancelled session</button>}
                </article>)}
                {selectedCompletions.map((completion) => <article className="rounded-md border border-[#d7e6d8] bg-[#f5faf5] p-3" key={completion.eventId}>
                  <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-[#4c8b5b]">Lesson completed</p>
                  <h4 className="mt-1 text-sm font-semibold text-[#19352d]">{completion.lessonTitle}</h4>
                  <p className="mt-1 text-xs text-[#68736d]">{completion.courseTitle}{completion.moduleTitle ? ` · ${completion.moduleTitle}` : ""}</p>
                  <Link className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#176b59] underline-offset-2 hover:underline" href={`/dashboard/courses/${completion.courseId}?topicId=${encodeURIComponent(completion.lessonId)}`}>Review lesson <ArrowUpRight aria-hidden="true" size={12} /></Link>
                </article>)}
                {!selectedSessions.length && !selectedCompletions.length && <div className="rounded-md bg-[#f6f8f5] px-4 py-5 text-center"><p className="text-sm font-medium text-[#405b4f]">Nothing planned for this day</p><p className="mt-1 text-xs leading-5 text-[#78847c]">Schedule a study session or choose another date.</p>{data.courses.length > 0 && <button className="mt-3 text-xs font-semibold text-[#176b59] underline underline-offset-2" onClick={openNewSession} type="button">Schedule a session</button>}</div>}
              </div>
            </aside>
          </section>

          <section>
            <article className="rounded-lg border border-[#dce3db] bg-white p-4 shadow-sm sm:p-5">
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.1em] text-[#c35d42]">Recommended next step</p>
              {recommended ? <>
                <h3 className="mt-2 text-base font-semibold text-[#19352d]">{recommended.lesson.title}</h3>
                <p className="mt-1 text-sm text-[#68736d]">{recommended.course.title} <span aria-hidden="true">·</span> {recommended.lesson.moduleTitle}</p>
                <Link className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-md bg-[#176b59] px-3.5 py-2 text-sm font-semibold text-white hover:bg-[#125644] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59]" href={`/dashboard/courses/${recommended.course.courseId}?topicId=${encodeURIComponent(recommended.lesson.lessonId)}`}>Open lesson <ArrowUpRight aria-hidden="true" size={15} /></Link>
              </> : <>
                <h3 className="mt-2 text-base font-semibold text-[#19352d]">No lesson to recommend yet</h3>
                <p className="mt-1 text-sm leading-5 text-[#68736d]">Generate a saved syllabus to see the next incomplete lesson here.</p>
              </>}
              {data.completions.length > 0 && <div className="mt-5 border-t border-[#e8ede8] pt-4">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-[#68776e]">Recent completed lessons</h4>
                <ul className="mt-2 space-y-2">
                  {data.completions.slice(-3).reverse().map((completion) => <li className="flex min-w-0 items-start justify-between gap-2 text-xs" key={completion.eventId}><span className="min-w-0"><span className="block truncate font-medium text-[#31463b]">{completion.lessonTitle}</span><span className="text-[#78847c]">{completion.courseTitle}</span></span><time className="shrink-0 text-[#78847c]" dateTime={completion.completedAt}>{new Date(completion.completedAt).toLocaleDateString()}</time></li>)}
                </ul>
              </div>}
            </article>
          </section>
        </>
      )}

      {dialogOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#12271f]/45 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setDialogOpen(false); }} role="presentation">
        <section aria-labelledby="planner-dialog-title" aria-modal="true" className="max-h-[min(90dvh,48rem)] w-full max-w-xl overflow-y-auto rounded-lg border border-[#dce3db] bg-white p-5 shadow-xl sm:p-6" role="dialog">
          <header className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[#c35d42]">Study session</p>
              <h3 className="mt-1 text-lg font-semibold text-[#19352d]" id="planner-dialog-title">{editingSessionId ? "Edit planned session" : "Schedule study session"}</h3>
            </div>
            <button aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-md text-[#617168] hover:bg-[#f1f5f1] focus-visible:outline-2 focus-visible:outline-[#176b59]" disabled={saving} onClick={() => setDialogOpen(false)} type="button"><X aria-hidden="true" size={18} /></button>
          </header>
          <form className="mt-5 space-y-4" onSubmit={(event) => void submitSession(event)}>
            <label className="block text-sm font-medium text-[#31463b]">Course
              <select className="mt-1.5 block min-h-11 w-full rounded-md border border-[#d6dfd8] bg-white px-3 text-sm outline-none focus:border-[#176b59] focus:ring-2 focus:ring-[#176b59]/15" onChange={(event) => setDraft((current) => ({ ...current, courseId: event.target.value, lessonId: "" }))} required value={draft.courseId}>
                <option value="">Choose a course</option>
                {data?.courses.map((course) => <option key={course.courseId} value={course.courseId}>{course.title}{course.syllabusStatus !== "ready" ? " · syllabus not ready" : ""}</option>)}
              </select>
            </label>
            <label className="block text-sm font-medium text-[#31463b]">Lesson <span className="font-normal text-[#78847c]">(optional)</span>
              <select className="mt-1.5 block min-h-11 w-full rounded-md border border-[#d6dfd8] bg-white px-3 text-sm outline-none focus:border-[#176b59] focus:ring-2 focus:ring-[#176b59]/15" disabled={!data?.courses.find((course) => course.courseId === draft.courseId)?.lessons.length} onChange={(event) => setDraft((current) => ({ ...current, lessonId: event.target.value }))} value={draft.lessonId}>
                <option value="">No specific lesson</option>
                {data?.courses.find((course) => course.courseId === draft.courseId)?.lessons.filter((lesson) => lesson.status !== "completed").map((lesson) => <option key={lesson.lessonId} value={lesson.lessonId}>{lesson.moduleTitle} · {lesson.title}</option>)}
              </select>
              {!data?.courses.find((course) => course.courseId === draft.courseId)?.lessons.length && <p className="mt-1 text-xs text-[#78847c]">Lesson selection is available after a syllabus is saved.</p>}
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium text-[#31463b]">Date
                <input className="mt-1.5 block min-h-11 w-full rounded-md border border-[#d6dfd8] px-3 text-sm outline-none focus:border-[#176b59] focus:ring-2 focus:ring-[#176b59]/15" onChange={(event) => setDraft((current) => ({ ...current, date: event.target.value }))} required type="date" value={draft.date} />
              </label>
              <label className="text-sm font-medium text-[#31463b]">Start time <span className="font-normal text-[#78847c]">({effectiveTimeZone})</span>
                <input className="mt-1.5 block min-h-11 w-full rounded-md border border-[#d6dfd8] px-3 text-sm outline-none focus:border-[#176b59] focus:ring-2 focus:ring-[#176b59]/15" onChange={(event) => setDraft((current) => ({ ...current, time: event.target.value }))} required type="time" value={draft.time} />
              </label>
            </div>
            <label className="block text-sm font-medium text-[#31463b]">Duration
              <select className="mt-1.5 block min-h-11 w-full rounded-md border border-[#d6dfd8] bg-white px-3 text-sm outline-none focus:border-[#176b59] focus:ring-2 focus:ring-[#176b59]/15" onChange={(event) => setDraft((current) => ({ ...current, durationMinutes: Number(event.target.value) }))} value={draft.durationMinutes}>
                {[15, 30, 45, 60, 90, 120, 180, 240].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? "" : "s"}`}</option>)}
              </select>
            </label>
            <label className="block text-sm font-medium text-[#31463b]">Study note <span className="font-normal text-[#78847c]">(optional)</span>
              <textarea className="mt-1.5 block w-full resize-y rounded-md border border-[#d6dfd8] px-3 py-2.5 text-sm outline-none focus:border-[#176b59] focus:ring-2 focus:ring-[#176b59]/15" maxLength={1000} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} rows={3} value={draft.note} />
            </label>
            {sessionError && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{sessionError}</p>}
            <div className="flex flex-wrap justify-end gap-2 border-t border-[#e8ede8] pt-4">
              <button className="min-h-10 rounded-md border border-[#d6dfd8] px-4 text-sm font-semibold text-[#52645b] hover:bg-[#f4f7f3] disabled:opacity-50" disabled={saving} onClick={() => setDialogOpen(false)} type="button">Cancel</button>
              <button className="inline-flex min-h-10 items-center gap-2 rounded-md bg-[#176b59] px-4 text-sm font-semibold text-white hover:bg-[#125644] disabled:opacity-60" disabled={saving} type="submit"><CalendarDays aria-hidden="true" size={16} />{saving ? "Saving..." : editingSessionId ? "Save changes" : "Schedule session"}</button>
            </div>
          </form>
        </section>
      </div>}
    </div>
  );
}
