"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { createLearningGoal } from "@/lib/learning-data";

type TimelineType = "days" | "date";
type SkillLevel = "beginner" | "intermediate" | "advanced";
const fieldClass = "mt-1.5 block w-full rounded-md border border-[#d9ddd5] bg-white px-3 py-2.5 text-sm font-normal outline-none focus:border-[#1b302b] focus:ring-2 focus:ring-[#1b302b]/10";

export default function NewLearningGoalPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [courseName, setCourseName] = useState("");
  const [goalText, setGoalText] = useState("");
  const [skillLevel, setSkillLevel] = useState<SkillLevel>("beginner");
  const [timelineType, setTimelineType] = useState<TimelineType>("days");
  const [targetDays, setTargetDays] = useState(30);
  const [targetDate, setTargetDate] = useState("");
  const [studyHoursPerDay, setStudyHoursPerDay] = useState(1);
  const [preferredLearningStyle, setPreferredLearningStyle] = useState("");
  const [additionalRequirements, setAdditionalRequirements] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedGoalId, setSavedGoalId] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace("/signin");
  }, [loading, router, user]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;

    setError("");
    setSaving(true);
    try {
      const goalId = savedGoalId ?? await createLearningGoal(user.uid, {
          courseName,
          goalText,
          skillLevel,
          timelineType,
          targetDays: timelineType === "days" ? targetDays : null,
          targetDate: timelineType === "date" ? targetDate : null,
          studyHoursPerDay,
          preferredLearningStyle,
          additionalRequirements,
        });
      setSavedGoalId(goalId);

      const token = await user.getIdToken();
      const response = await fetch("/api/syllabus/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ courseId: goalId }),
        signal: AbortSignal.timeout(155_000),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(typeof result.detail === "string" ? result.detail : "Syllabus generation failed. Please retry.");
      }
      router.replace(`/dashboard/courses/${goalId}`);
    } catch (saveError) {
      setError(saveError instanceof Error
        ? saveError.name === "TimeoutError"
          ? "Syllabus generation timed out. Your learning goal is saved; check the course before retrying."
          : saveError.message
        : "Unable to save this learning goal or generate its syllabus.");
    } finally {
      setSaving(false);
    }
  }

  if (loading || !user) {
    return <main className="flex min-h-screen items-center justify-center bg-[#f6f5ef] text-sm text-[#68736d]">Loading your learning space...</main>;
  }

  return (
    <main className="min-h-screen bg-[#f6f5ef] px-5 py-8 text-[#1b302b] sm:px-8 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <Link className="text-sm font-semibold text-[#586761] hover:text-[#1b302b]" href="/dashboard">← Dashboard</Link>
        <div className="mt-6">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#d16445]">New learning goal</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Set up a course</h1>
          <p className="mt-2 text-sm leading-6 text-[#68736d]">Add a few details to shape your learning space. You can refine your plan later.</p>
        </div>

        <form className="mt-7 space-y-6 rounded-lg border border-[#e0e2d9] bg-white p-6 sm:p-8" onSubmit={handleSubmit}>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="text-sm font-medium sm:col-span-2">
              Course or subject name
              <input autoFocus className={fieldClass} maxLength={120} onChange={(event) => setCourseName(event.target.value)} placeholder="e.g. Python programming" required value={courseName} />
            </label>
            <label className="text-sm font-medium sm:col-span-2">
              What do you want to achieve?
              <textarea className={`${fieldClass} min-h-24 resize-y`} maxLength={2000} onChange={(event) => setGoalText(event.target.value)} placeholder="Describe the outcome you are working toward" required value={goalText} />
            </label>
            <label className="text-sm font-medium">
              Current skill level
              <select className={fieldClass} onChange={(event) => setSkillLevel(event.target.value as SkillLevel)} value={skillLevel}>
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="advanced">Advanced</option>
              </select>
            </label>
            <label className="text-sm font-medium">
              Study hours per day
              <input className={fieldClass} max="24" min="0.25" onChange={(event) => setStudyHoursPerDay(Number(event.target.value))} required step="0.25" type="number" value={studyHoursPerDay} />
            </label>
            <fieldset className="sm:col-span-2">
              <legend className="text-sm font-medium">Target timeline</legend>
              <div className="mt-2 inline-flex rounded-md border border-[#d9ddd5] p-1">
                <button aria-pressed={timelineType === "days"} className={`rounded px-3 py-1.5 text-sm ${timelineType === "days" ? "bg-[#1b302b] text-white" : "text-[#586761]"}`} onClick={() => setTimelineType("days")} type="button">Number of days</button>
                <button aria-pressed={timelineType === "date"} className={`rounded px-3 py-1.5 text-sm ${timelineType === "date" ? "bg-[#1b302b] text-white" : "text-[#586761]"}`} onClick={() => setTimelineType("date")} type="button">Target date</button>
              </div>
              {timelineType === "days" ? (
                <input aria-label="Target number of days" className={fieldClass} max="3650" min="1" onChange={(event) => setTargetDays(Number(event.target.value))} required type="number" value={targetDays} />
              ) : (
                <input aria-label="Target date" className={fieldClass} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setTargetDate(event.target.value)} required type="date" value={targetDate} />
              )}
            </fieldset>
            <label className="text-sm font-medium sm:col-span-2">
              Preferred learning style <span className="font-normal text-[#89938c]">(optional)</span>
              <select className={fieldClass} onChange={(event) => setPreferredLearningStyle(event.target.value)} value={preferredLearningStyle}>
                <option value="">No preference</option>
                <option value="visual">Visual</option>
                <option value="auditory">Listening and discussion</option>
                <option value="reading-writing">Reading and writing</option>
                <option value="hands-on">Hands-on practice</option>
                <option value="mixed">A mix of styles</option>
              </select>
            </label>
            <label className="text-sm font-medium sm:col-span-2">
              Additional requirements <span className="font-normal text-[#89938c]">(optional)</span>
              <textarea className={`${fieldClass} min-h-20 resize-y`} maxLength={2000} onChange={(event) => setAdditionalRequirements(event.target.value)} placeholder="Anything else to keep in mind?" value={additionalRequirements} />
            </label>
          </div>

          {error && <p className="text-sm text-red-800" role="alert">{error}</p>}
          <div className="flex flex-wrap justify-end gap-3 border-t border-[#edf0e9] pt-5">
            <Link className="rounded-md border border-[#d9ddd5] px-4 py-2.5 text-sm font-semibold text-[#586761] hover:border-[#1b302b]" href="/dashboard">Cancel</Link>
            <button className="rounded-md bg-[#d16445] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#b84f34] disabled:opacity-60" disabled={saving} type="submit">
              {saving ? "Generating syllabus..." : savedGoalId ? "Retry syllabus generation" : "Save & Generate Syllabus"}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
