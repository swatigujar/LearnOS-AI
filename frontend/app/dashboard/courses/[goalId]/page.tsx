"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { CourseSyllabus } from "@/components/course-syllabus";
import { CourseNotesFolder } from "@/components/course-notes-folder";
import {
  deleteLearningGoal,
  getLearningGoal,
  timelineDurationInDays,
  updateLearningGoalTimeline,
  type LearningGoal,
} from "@/lib/learning-data";

export default function LearningWorkspacePage() {
  const router = useRouter();
  const params = useParams<{ goalId: string }>();
  const { user, loading } = useAuth();
  const [goal, setGoal] = useState<LearningGoal | null>(null);
  const [loadingGoal, setLoadingGoal] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingTimeline, setEditingTimeline] = useState(false);
  const [timelineType, setTimelineType] = useState<"days" | "date">("days");
  const [targetDays, setTargetDays] = useState(30);
  const [targetDate, setTargetDate] = useState("");
  const [studyHoursPerDay, setStudyHoursPerDay] = useState(1);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [savingUpdate, setSavingUpdate] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState<"learning" | "notes">("learning");

  useEffect(() => {
    if (!loading && !user) router.replace("/signin");
  }, [loading, router, user]);

  useEffect(() => {
    if (!user || !params.goalId) return;
    let active = true;
    getLearningGoal(user.uid, params.goalId)
      .then((savedGoal) => {
        if (!active) return;
        setGoal(savedGoal);
        if (savedGoal) {
          const savedTimelineType = savedGoal.timelineType ?? (savedGoal.targetDate ? "date" : "days");
          setTimelineType(savedTimelineType);
          setTargetDays(savedGoal.targetDays ?? 30);
          setTargetDate(savedGoal.targetDate ?? "");
          setStudyHoursPerDay(savedGoal.studyHoursPerDay ?? 1);
        }
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Unable to load this course.");
      })
      .finally(() => {
        if (active) setLoadingGoal(false);
      });
    return () => {
      active = false;
    };
  }, [params.goalId, user]);

  function requestTimelineUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConfirmUpdate(true);
  }

  async function saveTimelineUpdate() {
    if (!user || !goal) return;
    setSavingUpdate(true);
    setError("");
    try {
      const result = await updateLearningGoalTimeline(user.uid, goal.id, {
        timelineType,
        targetDays: timelineType === "days" ? targetDays : null,
        targetDate: timelineType === "date" ? targetDate : null,
        studyHoursPerDay,
      });
      const updatedGoal = await getLearningGoal(user.uid, goal.id);
      setGoal(updatedGoal);
      setEditingTimeline(false);
      setConfirmUpdate(false);
      setNotice(result.accelerated
        ? "Timeline updated and marked for accelerated prioritization. No syllabus was generated or revised."
        : "Timeline and study time updated. No syllabus was generated or revised.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to update the course timeline.");
      setConfirmUpdate(false);
    } finally {
      setSavingUpdate(false);
    }
  }

  async function removeCourse() {
    if (!user || !goal) return;
    setDeleting(true);
    setError("");
    try {
      await deleteLearningGoal(user.uid, goal.id, await user.getIdToken());
      router.replace("/dashboard");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete this course.");
      setConfirmDelete(false);
      setDeleting(false);
    }
  }

  if (loading || !user || loadingGoal) {
    return <main className="flex min-h-screen items-center justify-center bg-[#FFF8F1] text-sm text-[#756B80]">Loading your course...</main>;
  }

  if (error || !goal) {
    return (
      <main className="min-h-screen bg-[#FFF8F1] px-5 py-10 text-[#29213D]">
        <div className="mx-auto max-w-3xl rounded-lg border border-[#EEE5E0] bg-white p-7">
          <h1 className="text-xl font-semibold">Course unavailable</h1>
          <p className="mt-2 text-sm text-[#756B80]">{error || "This learning goal could not be found."}</p>
          <Link className="mt-5 inline-block text-sm font-semibold underline underline-offset-4" href="/dashboard">Return to Dashboard</Link>
        </div>
      </main>
    );
  }

  const targetSummary = goal.timelineType === "date" && goal.targetDate
    ? `Target date: ${goal.targetDate}`
    : goal.targetDays
      ? `${goal.targetDays} days`
      : "Not set";
  const currentTimelineDays = timelineDurationInDays({
    timelineType: goal.timelineType ?? (goal.targetDate ? "date" : "days"),
    targetDays: goal.targetDays ?? null,
    targetDate: goal.targetDate ?? null,
  });

  const suggestedPriority = goal.timelinePriority === "accelerated";

  return (
    <main className="min-h-screen bg-[#FFF8F1] px-5 py-8 text-[#29213D] sm:px-8 sm:py-10">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link className="text-sm font-semibold text-[#756B80] hover:text-[#29213D]" href="/dashboard">← Dashboard</Link>
          <div className="flex flex-wrap items-center gap-2">
            <Link className="rounded-md border border-[#EEE5E0] bg-white px-3 py-2 text-sm font-semibold text-[#642BD8] transition hover:border-[#642BD8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]" href={`/dashboard/courses/${goal.id}/mock-test`}>
              Mock Test
            </Link>
            <button className="rounded-md border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 transition hover:border-red-400 disabled:opacity-60" disabled={deleting} onClick={() => setConfirmDelete(true)} type="button">
              Delete course
            </button>
          </div>
        </div>
        <section className="relative mt-6 overflow-hidden rounded-[1.75rem] border border-[#E7DDF8] bg-[linear-gradient(118deg,#F2ECFF_0%,#FFFDFB_62%,#FCEAF1_100%)] px-5 py-6 shadow-[0_22px_65px_-50px_rgba(74,40,95,0.3)] sm:px-8 sm:py-8">
          <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-[#F8B4D0]/30 blur-3xl" />
          <div className="relative">
          <p className="inline-flex items-center rounded-full border border-[#E7DDF8] bg-white/80 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.15em] text-[#642BD8]">Learning workspace</p>
          <h1 className="mt-3 break-words text-3xl font-bold tracking-[-0.03em] text-[#29213D] sm:text-4xl">{goal.courseName}</h1>
          <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-[#756B80]">{goal.goalText}</p>
          </div>
        </section>
        <details className="mt-5 rounded-2xl border border-[#EEE5E0] bg-white px-4 py-3 shadow-[0_12px_32px_-30px_rgba(36,34,70,0.45)] sm:px-5" open={editingTimeline}>
          <summary className="cursor-pointer text-sm font-semibold focus-visible:outline-2 focus-visible:outline-[#642BD8]">Course settings</summary>
        <section className="pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Setup details</h2>
            <div className="flex flex-wrap gap-2">
              <button className="learnos-secondary-button rounded-xl px-3 py-2 text-sm transition hover:border-[#642BD8]" onClick={() => { setEditingTimeline((current) => !current); setNotice(""); }} type="button">
                {editingTimeline ? "Cancel edit" : "Edit timeline"}
              </button>
            </div>
          </div>
          {error && <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p>}
          {notice && <p className="mt-4 rounded-xl border border-[#CFE3D2] bg-[#EAF4EC] px-3 py-2 text-sm text-[#31553d]" role="status">{notice}</p>}

          {editingTimeline ? (
            <form className="mt-5 grid gap-4 border-t border-[#EEE5E0] pt-5 sm:grid-cols-2" onSubmit={requestTimelineUpdate}>
              <fieldset className="sm:col-span-2">
                <legend className="text-sm font-medium">Target timeline</legend>
                <div className="mt-2 inline-flex rounded-md border border-[#EEE5E0] p-1">
                  <button aria-pressed={timelineType === "days"} className={`rounded-lg px-3 py-1.5 text-sm ${timelineType === "days" ? "bg-[#642BD8] text-white" : "text-[#756B80]"}`} onClick={() => setTimelineType("days")} type="button">Number of days</button>
                  <button aria-pressed={timelineType === "date"} className={`rounded-lg px-3 py-1.5 text-sm ${timelineType === "date" ? "bg-[#642BD8] text-white" : "text-[#756B80]"}`} onClick={() => setTimelineType("date")} type="button">Target date</button>
                </div>
                {timelineType === "days" ? (
                  <input aria-label="Target number of days" className="mt-2 block w-full rounded-xl border border-[#EEE5E0] px-3.5 py-3 text-sm outline-none focus:border-[#642BD8]" max="3650" min="1" onChange={(event) => setTargetDays(Number(event.target.value))} required type="number" value={targetDays} />
                ) : (
                  <input aria-label="Target date" className="mt-2 block w-full rounded-xl border border-[#EEE5E0] px-3.5 py-3 text-sm outline-none focus:border-[#642BD8]" min={new Date().toISOString().slice(0, 10)} onChange={(event) => setTargetDate(event.target.value)} required type="date" value={targetDate} />
                )}
              </fieldset>
              <label className="text-sm font-medium">
                Study hours per day
                <input className="mt-1.5 block w-full rounded-xl border border-[#EEE5E0] px-3.5 py-3 text-sm font-normal outline-none focus:border-[#642BD8]" max="24" min="0.25" onChange={(event) => setStudyHoursPerDay(Number(event.target.value))} required step="0.25" type="number" value={studyHoursPerDay} />
              </label>
              <div className="flex items-end sm:justify-end">
                <button className="learnos-primary-button px-4 py-2.5 text-sm" type="submit">Review changes</button>
              </div>
            </form>
          ) : (
            <dl className="mt-5 grid gap-x-8 gap-y-5 border-t border-[#EEE5E0] pt-5 sm:grid-cols-2">
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#858398]">Current level</dt><dd className="mt-1 text-sm capitalize">{goal.skillLevel || "Not recorded"}</dd></div>
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#858398]">Target timeline</dt><dd className="mt-1 text-sm">{targetSummary}</dd></div>
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#858398]">Study time</dt><dd className="mt-1 text-sm">{goal.studyHoursPerDay ? `${goal.studyHoursPerDay} hours per day` : "Not recorded"}</dd></div>
              {goal.preferredLearningStyle && <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#858398]">Preferred style</dt><dd className="mt-1 text-sm capitalize">{goal.preferredLearningStyle.replaceAll("-", " ")}</dd></div>}
              {goal.timelineUpdated && <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#858398]">Timeline status</dt><dd className="mt-1 text-sm">{suggestedPriority ? "Updated · accelerated priority" : "Updated"}</dd></div>}
            </dl>
          )}
          {goal.additionalRequirements && <div className="mt-6 border-t border-[#EEE5E0] pt-5"><h3 className="text-xs font-semibold uppercase tracking-wide text-[#858398]">Additional requirements</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{goal.additionalRequirements}</p></div>}
        </section>
        </details>
        <nav aria-label="Course sections" className="mt-6 inline-flex max-w-full gap-1 rounded-xl border border-[#EEE5E0] bg-white p-1 shadow-[0_12px_32px_-30px_rgba(36,34,70,0.45)]">
          {(["learning", "notes"] as const).map((tab) => <button aria-current={activeTab === tab ? "page" : undefined} className={`min-h-10 rounded-lg px-4 py-2 text-sm font-semibold transition ${activeTab === tab ? "bg-[#642BD8] text-white shadow-sm" : "text-[#756B80] hover:bg-[#F2ECFF] hover:text-[#29213D]"}`} key={tab} onClick={() => setActiveTab(tab)} type="button">{tab === "learning" ? "Learning & Tutor" : "Notes"}</button>)}
        </nav>
        {activeTab === "notes" ? <CourseNotesFolder courseId={goal.id} key={goal.id} user={user} /> : <CourseSyllabus
          courseId={goal.id}
          currentStudyHoursPerDay={goal.studyHoursPerDay ?? null}
          currentTimelineDays={currentTimelineDays}
          key={goal.id}
          timelineUpdated={Boolean(goal.timelineUpdated)}
        />}
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5" role="presentation">
          <section aria-labelledby="delete-course-title" aria-modal="true" className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl" role="dialog">
            <h2 className="text-lg font-semibold" id="delete-course-title">Delete course</h2>
            <p className="mt-3 text-sm leading-6 text-[#756B80]">Are you sure you want to delete this course?</p>
            <div className="mt-6 flex justify-end gap-3">
              <button className="rounded-md border border-[#EEE5E0] px-4 py-2.5 text-sm font-semibold" disabled={deleting} onClick={() => setConfirmDelete(false)} type="button">Cancel</button>
              <button className="rounded-md bg-red-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60" disabled={deleting} onClick={removeCourse} type="button">{deleting ? "Deleting..." : "Delete"}</button>
            </div>
          </section>
        </div>
      )}

      {confirmUpdate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5" role="presentation">
          <section aria-labelledby="update-timeline-title" aria-modal="true" className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl" role="dialog">
            <h2 className="text-lg font-semibold" id="update-timeline-title">Confirm timeline update</h2>
            <p className="mt-3 text-sm leading-6 text-[#756B80]">Save the updated timeline and study hours? This does not generate or revise a syllabus.</p>
            <div className="mt-6 flex justify-end gap-3">
              <button className="rounded-md border border-[#EEE5E0] px-4 py-2.5 text-sm font-semibold" disabled={savingUpdate} onClick={() => setConfirmUpdate(false)} type="button">Cancel</button>
              <button className="rounded-md bg-[#29213D] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60" disabled={savingUpdate} onClick={saveTimelineUpdate} type="button">{savingUpdate ? "Saving..." : "Confirm changes"}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
