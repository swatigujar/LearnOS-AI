"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { CourseSyllabus } from "@/components/course-syllabus";
import {
  deleteLearningGoal,
  getLearningGoal,
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
        ? "Timeline updated. The course is marked for accelerated prioritization."
        : "Timeline and study time updated.");
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
      await deleteLearningGoal(user.uid, goal.id);
      router.replace("/dashboard");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to delete this course.");
      setConfirmDelete(false);
      setDeleting(false);
    }
  }

  if (loading || !user || loadingGoal) {
    return <main className="flex min-h-screen items-center justify-center bg-[#f6f5ef] text-sm text-[#68736d]">Loading your course...</main>;
  }

  if (error || !goal) {
    return (
      <main className="min-h-screen bg-[#f6f5ef] px-5 py-10 text-[#1b302b]">
        <div className="mx-auto max-w-3xl rounded-lg border border-[#e0e2d9] bg-white p-7">
          <h1 className="text-xl font-semibold">Course unavailable</h1>
          <p className="mt-2 text-sm text-[#68736d]">{error || "This learning goal could not be found."}</p>
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

  const suggestedPriority = goal.timelinePriority === "accelerated";

  return (
    <main className="min-h-screen bg-[#f6f5ef] px-5 py-8 text-[#1b302b] sm:px-8 sm:py-10">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link className="text-sm font-semibold text-[#586761] hover:text-[#1b302b]" href="/dashboard">← Dashboard</Link>
          <button className="rounded-md border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 transition hover:border-red-400 disabled:opacity-60" disabled={deleting} onClick={() => setConfirmDelete(true)} type="button">
            Delete course
          </button>
        </div>
        <section className="mt-6 border-b border-[#e0e2d9] py-5">
          <p className="text-xs font-bold uppercase tracking-wide text-[#d16445]">Learning workspace</p>
          <h1 className="mt-2 break-words text-2xl font-semibold">{goal.courseName}</h1>
          <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-[#68736d]">{goal.goalText}</p>
        </section>
        <details className="mt-4 border-b border-[#e0e2d9] pb-4" open={editingTimeline}>
          <summary className="cursor-pointer text-sm font-semibold focus-visible:outline-2 focus-visible:outline-[#1b6657]">Course settings</summary>
        <section className="pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Setup details</h2>
            <div className="flex flex-wrap gap-2">
              <button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-sm font-semibold transition hover:border-[#1b302b]" onClick={() => { setEditingTimeline((current) => !current); setNotice(""); }} type="button">
                {editingTimeline ? "Cancel edit" : "Edit timeline"}
              </button>
            </div>
          </div>
          {error && <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p>}
          {notice && <p className="mt-4 rounded-md border border-[#dce9df] bg-[#f0f7f1] px-3 py-2 text-sm text-[#31553d]" role="status">{notice}</p>}

          {editingTimeline ? (
            <form className="mt-5 grid gap-4 border-t border-[#edf0e9] pt-5 sm:grid-cols-2" onSubmit={requestTimelineUpdate}>
              <fieldset className="sm:col-span-2">
                <legend className="text-sm font-medium">Target timeline</legend>
                <div className="mt-2 inline-flex rounded-md border border-[#d9ddd5] p-1">
                  <button aria-pressed={timelineType === "days"} className={`rounded px-3 py-1.5 text-sm ${timelineType === "days" ? "bg-[#1b302b] text-white" : "text-[#586761]"}`} onClick={() => setTimelineType("days")} type="button">Number of days</button>
                  <button aria-pressed={timelineType === "date"} className={`rounded px-3 py-1.5 text-sm ${timelineType === "date" ? "bg-[#1b302b] text-white" : "text-[#586761]"}`} onClick={() => setTimelineType("date")} type="button">Target date</button>
                </div>
                {timelineType === "days" ? (
                  <input aria-label="Target number of days" className="mt-2 block w-full rounded-md border border-[#d9ddd5] px-3 py-2.5 text-sm outline-none focus:border-[#1b302b]" max="3650" min="1" onChange={(event) => setTargetDays(Number(event.target.value))} required type="number" value={targetDays} />
                ) : (
                  <input aria-label="Target date" className="mt-2 block w-full rounded-md border border-[#d9ddd5] px-3 py-2.5 text-sm outline-none focus:border-[#1b302b]" min={new Date().toISOString().slice(0, 10)} onChange={(event) => setTargetDate(event.target.value)} required type="date" value={targetDate} />
                )}
              </fieldset>
              <label className="text-sm font-medium">
                Study hours per day
                <input className="mt-1.5 block w-full rounded-md border border-[#d9ddd5] px-3 py-2.5 text-sm font-normal outline-none focus:border-[#1b302b]" max="24" min="0.25" onChange={(event) => setStudyHoursPerDay(Number(event.target.value))} required step="0.25" type="number" value={studyHoursPerDay} />
              </label>
              <div className="flex items-end sm:justify-end">
                <button className="rounded-md bg-[#1b302b] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#28473f]" type="submit">Review changes</button>
              </div>
            </form>
          ) : (
            <dl className="mt-5 grid gap-x-8 gap-y-5 border-t border-[#edf0e9] pt-5 sm:grid-cols-2">
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Current level</dt><dd className="mt-1 text-sm capitalize">{goal.skillLevel || "Not recorded"}</dd></div>
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Target timeline</dt><dd className="mt-1 text-sm">{targetSummary}</dd></div>
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Study time</dt><dd className="mt-1 text-sm">{goal.studyHoursPerDay ? `${goal.studyHoursPerDay} hours per day` : "Not recorded"}</dd></div>
              {goal.preferredLearningStyle && <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Preferred style</dt><dd className="mt-1 text-sm capitalize">{goal.preferredLearningStyle.replaceAll("-", " ")}</dd></div>}
              {goal.timelineUpdated && <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Timeline status</dt><dd className="mt-1 text-sm">{suggestedPriority ? "Updated · accelerated priority" : "Updated"}</dd></div>}
            </dl>
          )}
          {goal.additionalRequirements && <div className="mt-6 border-t border-[#edf0e9] pt-5"><h3 className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Additional requirements</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{goal.additionalRequirements}</p></div>}
        </section>
        </details>
        <CourseSyllabus courseId={goal.id} key={goal.id} />
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5" role="presentation">
          <section aria-labelledby="delete-course-title" aria-modal="true" className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl" role="dialog">
            <h2 className="text-lg font-semibold" id="delete-course-title">Delete course</h2>
            <p className="mt-3 text-sm leading-6 text-[#586761]">Are you sure you want to delete this course?</p>
            <div className="mt-6 flex justify-end gap-3">
              <button className="rounded-md border border-[#d9ddd5] px-4 py-2.5 text-sm font-semibold" disabled={deleting} onClick={() => setConfirmDelete(false)} type="button">Cancel</button>
              <button className="rounded-md bg-red-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60" disabled={deleting} onClick={removeCourse} type="button">{deleting ? "Deleting..." : "Delete"}</button>
            </div>
          </section>
        </div>
      )}

      {confirmUpdate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5" role="presentation">
          <section aria-labelledby="update-timeline-title" aria-modal="true" className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl" role="dialog">
            <h2 className="text-lg font-semibold" id="update-timeline-title">Confirm timeline update</h2>
            <p className="mt-3 text-sm leading-6 text-[#586761]">Save the updated timeline and study hours? Existing course content will be preserved.</p>
            <div className="mt-6 flex justify-end gap-3">
              <button className="rounded-md border border-[#d9ddd5] px-4 py-2.5 text-sm font-semibold" disabled={savingUpdate} onClick={() => setConfirmUpdate(false)} type="button">Cancel</button>
              <button className="rounded-md bg-[#1b302b] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60" disabled={savingUpdate} onClick={saveTimelineUpdate} type="button">{savingUpdate ? "Saving..." : "Confirm changes"}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}