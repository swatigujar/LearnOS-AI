"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { createLearningGoal } from "@/lib/learning-data";

type TimelineType = "days" | "date";
type SkillLevel = "beginner" | "intermediate" | "advanced";
type FieldName = "courseName" | "goalText" | "studyHoursPerDay" | "targetDays" | "targetDate";
type FieldErrors = Partial<Record<FieldName, string>>;
const fieldClass = "mt-1.5 block w-full rounded-xl border border-[#EEE5E0] bg-white px-3.5 py-3 text-sm font-normal outline-none transition focus:border-[#642BD8] focus:ring-2 focus:ring-[#642BD8]/15";
const fieldErrorClass = "border-red-700 focus:border-red-700 focus:ring-red-700/10";

function formatElapsedTime(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

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
  const [submissionStartedAt, setSubmissionStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [savedGoalId, setSavedGoalId] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace("/signin");
  }, [loading, router, user]);

  useEffect(() => {
    if (!saving || submissionStartedAt === null) return;
    const updateElapsed = () => setElapsedSeconds(Math.floor((Date.now() - submissionStartedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [saving, submissionStartedAt]);

  function clearFieldError(field: FieldName) {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;

    const nextErrors: FieldErrors = {};
    if (!courseName.trim()) nextErrors.courseName = "Enter a course or subject name.";
    if (!goalText.trim()) nextErrors.goalText = "Describe what you want to achieve.";
    if (!Number.isFinite(studyHoursPerDay) || studyHoursPerDay < 0.25 || studyHoursPerDay > 24) {
      nextErrors.studyHoursPerDay = "Enter between 0.25 and 24 study hours per day.";
    } else if (Math.round(studyHoursPerDay * 4) !== studyHoursPerDay * 4) {
      nextErrors.studyHoursPerDay = "Choose study time in 0.25-hour increments.";
    }
    if (timelineType === "days" && (!Number.isInteger(targetDays) || targetDays < 1 || targetDays > 3650)) {
      nextErrors.targetDays = "Enter a timeline between 1 and 3650 days.";
    }
    if (timelineType === "date" && (!targetDate || targetDate <= new Date().toISOString().slice(0, 10))) {
      nextErrors.targetDate = "Choose a target date after today.";
    }
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }

    setError("");
    setSubmissionStartedAt(Date.now());
    setElapsedSeconds(0);
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
      setSubmissionStartedAt(null);
    }
  }

  if (loading || !user) {
    return <main className="flex min-h-screen items-center justify-center bg-[#FFF8F1] text-sm text-[#756B80]">Loading your learning space...</main>;
  }

  return (
    <main className="min-h-screen bg-[#FFF8F1] px-5 py-8 text-[#29213D] sm:px-8 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <Link className="text-sm font-semibold text-[#756B80] hover:text-[#29213D]" href="/dashboard">← Dashboard</Link>
        <div className="mt-6">
          <p className="inline-flex rounded-full border border-[#E7DDF8] bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[#642BD8]">New learning goal</p>
          <h1 className="mt-3 text-3xl font-bold tracking-[-0.035em] text-[#29213D]">Set up a course</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#756B80]">Add a few details to shape your learning space. You can refine your plan later. Fields marked <span className="font-semibold text-[#29213D]">Required</span> are needed to create your course.</p>
        </div>

        <form className="learnos-card mt-7 overflow-hidden px-5 shadow-[0_20px_55px_-45px_rgba(74,40,95,0.24)] sm:px-8" noValidate onSubmit={handleSubmit}>
          {savedGoalId && !saving && <div className="-mx-5 border-b border-[#dce9df] bg-[#F2ECFF] px-5 py-4 text-sm text-[#31553d] sm:-mx-8 sm:px-8" role="status">
            <p className="font-semibold">Saved course details</p>
            <p className="mt-1 leading-6">These details are locked because retry uses the saved goal. Open the course to check whether its syllabus finished saving.</p>
            <Link className="mt-2 inline-block font-semibold underline underline-offset-4" href={`/dashboard/courses/${savedGoalId}`}>Open saved course</Link>
          </div>}
          <fieldset className="m-0 min-w-0 border-0 p-0" disabled={saving || Boolean(savedGoalId)}>
            <legend className="sr-only">Course setup details</legend>
          <section aria-labelledby="goal-heading" className="space-y-5 border-b border-[#EEE5E0] py-6 sm:py-7">
            <div>
              <h2 className="text-lg font-semibold tracking-tight" id="goal-heading">Goal</h2>
              <p className="mt-1 text-sm leading-6 text-[#756B80]">Name the subject and describe the outcome you have in mind.</p>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <label className="block text-sm font-medium sm:col-span-2">
                Course or subject name <span className="text-[#642BD8]" aria-hidden="true">*</span><span className="sr-only"> Required</span>
                <input aria-describedby={`course-name-help${fieldErrors.courseName ? " course-name-error" : ""}`} aria-invalid={Boolean(fieldErrors.courseName)} autoFocus className={`${fieldClass} ${fieldErrors.courseName ? fieldErrorClass : ""}`} maxLength={120} onChange={(event) => { setCourseName(event.target.value); clearFieldError("courseName"); }} placeholder="e.g. Python programming" required value={courseName} />
                <span className="mt-1.5 block text-xs font-normal leading-5 text-[#756B80]" id="course-name-help">A short name you will recognize in your learning space.</span>
                {fieldErrors.courseName && <span className="mt-1 block text-xs font-medium text-red-800" id="course-name-error">{fieldErrors.courseName}</span>}
              </label>
              <label className="block text-sm font-medium sm:col-span-2">
                What do you want to achieve? <span className="text-[#642BD8]" aria-hidden="true">*</span><span className="sr-only"> Required</span>
                <textarea aria-describedby={`goal-text-help${fieldErrors.goalText ? " goal-text-error" : ""}`} aria-invalid={Boolean(fieldErrors.goalText)} className={`${fieldClass} min-h-28 resize-y ${fieldErrors.goalText ? fieldErrorClass : ""}`} maxLength={2000} onChange={(event) => { setGoalText(event.target.value); clearFieldError("goalText"); }} placeholder="Describe what you would like to be able to do when you finish." required value={goalText} />
                <span className="mt-1.5 block text-xs font-normal leading-5 text-[#756B80]" id="goal-text-help">A specific outcome helps shape the topics and level of detail.</span>
                {fieldErrors.goalText && <span className="mt-1 block text-xs font-medium text-red-800" id="goal-text-error">{fieldErrors.goalText}</span>}
              </label>
              <label className="block text-sm font-medium sm:col-span-2">
                Additional requirements <span className="font-normal text-[#858398]">(optional)</span>
                <textarea className={`${fieldClass} min-h-20 resize-y`} maxLength={2000} onChange={(event) => setAdditionalRequirements(event.target.value)} placeholder="For example, tools to use or topics to focus on." value={additionalRequirements} />
              </label>
            </div>
          </section>

          <section aria-labelledby="starting-point-heading" className="space-y-5 border-b border-[#EEE5E0] py-6 sm:py-7">
            <div>
              <h2 className="text-lg font-semibold tracking-tight" id="starting-point-heading">Starting point</h2>
              <p className="mt-1 text-sm leading-6 text-[#756B80]">Choose the level that best matches where you are now. You can skip a learning-style preference.</p>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <label className="block text-sm font-medium">
                Current skill level <span className="text-[#642BD8]" aria-hidden="true">*</span><span className="sr-only"> Required</span>
                <select className={fieldClass} onChange={(event) => setSkillLevel(event.target.value as SkillLevel)} required value={skillLevel}>
                  <option value="beginner">Beginner</option>
                  <option value="intermediate">Intermediate</option>
                  <option value="advanced">Advanced</option>
                </select>
              </label>
              <label className="block text-sm font-medium">
                Preferred learning style <span className="font-normal text-[#858398]">(optional)</span>
                <select className={fieldClass} onChange={(event) => setPreferredLearningStyle(event.target.value)} value={preferredLearningStyle}>
                  <option value="">No preference</option>
                  <option value="visual">Visual</option>
                  <option value="auditory">Listening and discussion</option>
                  <option value="reading-writing">Reading and writing</option>
                  <option value="hands-on">Hands-on practice</option>
                  <option value="mixed">A mix of styles</option>
                </select>
              </label>
            </div>
          </section>

          <section aria-labelledby="time-available-heading" className="space-y-5 py-6 sm:py-7">
            <div>
              <h2 className="text-lg font-semibold tracking-tight" id="time-available-heading">Time available</h2>
              <p className="mt-1 text-sm leading-6 text-[#756B80]">Set a realistic daily study amount and a target timeline.</p>
            </div>
            <div className="grid items-start gap-5 sm:grid-cols-2">
              <label className="block text-sm font-medium">
                Study hours per day <span className="text-[#642BD8]" aria-hidden="true">*</span><span className="sr-only"> Required</span>
                <input aria-describedby={`study-hours-help${fieldErrors.studyHoursPerDay ? " study-hours-error" : ""}`} aria-invalid={Boolean(fieldErrors.studyHoursPerDay)} className={`${fieldClass} ${fieldErrors.studyHoursPerDay ? fieldErrorClass : ""}`} max="24" min="0.25" onChange={(event) => { setStudyHoursPerDay(Number(event.target.value)); clearFieldError("studyHoursPerDay"); }} required step="0.25" type="number" value={studyHoursPerDay} />
                <span className="mt-1.5 block text-xs font-normal leading-5 text-[#756B80]" id="study-hours-help">From 0.25 to 24 hours, in quarter-hour steps.</span>
                {fieldErrors.studyHoursPerDay && <span className="mt-1 block text-xs font-medium text-red-800" id="study-hours-error">{fieldErrors.studyHoursPerDay}</span>}
              </label>
              <fieldset className="min-w-0">
                <legend className="text-sm font-medium">Target timeline <span className="text-[#642BD8]" aria-hidden="true">*</span><span className="sr-only"> Required</span></legend>
                <div aria-label="Timeline format" className="mt-1.5 flex w-full flex-wrap rounded-md border border-[#EEE5E0] p-1 sm:w-fit" role="group">
                  <button aria-pressed={timelineType === "days"} className={`min-h-10 flex-1 rounded-lg px-3 py-1.5 text-sm transition sm:flex-none ${timelineType === "days" ? "bg-[#642BD8] text-white" : "text-[#756B80] hover:bg-[#FFF8F1]"}`} onClick={() => setTimelineType("days")} type="button">Number of days</button>
                  <button aria-pressed={timelineType === "date"} className={`min-h-10 flex-1 rounded-lg px-3 py-1.5 text-sm transition sm:flex-none ${timelineType === "date" ? "bg-[#642BD8] text-white" : "text-[#756B80] hover:bg-[#FFF8F1]"}`} onClick={() => setTimelineType("date")} type="button">Target date</button>
                </div>
                {timelineType === "days" ? (
                  <>
                    <input aria-describedby={`target-days-help${fieldErrors.targetDays ? " target-days-error" : ""}`} aria-invalid={Boolean(fieldErrors.targetDays)} aria-label="Target number of days" className={`${fieldClass} ${fieldErrors.targetDays ? fieldErrorClass : ""}`} max="3650" min="1" onChange={(event) => { setTargetDays(Number(event.target.value)); clearFieldError("targetDays"); }} required step="1" type="number" value={targetDays} />
                    <span className="mt-1.5 block text-xs font-normal leading-5 text-[#756B80]" id="target-days-help">Choose between 1 and 3650 days.</span>
                    {fieldErrors.targetDays && <span className="mt-1 block text-xs font-medium text-red-800" id="target-days-error">{fieldErrors.targetDays}</span>}
                  </>
                ) : (
                  <>
                    <input aria-describedby={`target-date-help${fieldErrors.targetDate ? " target-date-error" : ""}`} aria-invalid={Boolean(fieldErrors.targetDate)} aria-label="Target date" className={`${fieldClass} ${fieldErrors.targetDate ? fieldErrorClass : ""}`} min={new Date().toISOString().slice(0, 10)} onChange={(event) => { setTargetDate(event.target.value); clearFieldError("targetDate"); }} required type="date" value={targetDate} />
                    <span className="mt-1.5 block text-xs font-normal leading-5 text-[#756B80]" id="target-date-help">Choose a date after today.</span>
                    {fieldErrors.targetDate && <span className="mt-1 block text-xs font-medium text-red-800" id="target-date-error">{fieldErrors.targetDate}</span>}
                  </>
                )}
              </fieldset>
            </div>
          </section>
          </fieldset>

          {saving && <div className="mb-5 rounded-md border border-[#EEE5E0] bg-[#FFF8F1] px-4 py-3 text-sm text-[#756B80]">
            <p role="status">Saving your course details and requesting syllabus generation. This can take a couple of minutes.</p>
            <p aria-live="off" className="mt-1 text-xs">Elapsed since submission: {formatElapsedTime(elapsedSeconds)}</p>
          </div>}

          {error && <p className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{error}</p>}
          <div className="-mx-5 flex flex-col-reverse gap-3 border-t border-[#EEE5E0] bg-[#fbfbf8] px-5 py-5 sm:mx-0 sm:flex-row sm:justify-end sm:bg-transparent sm:px-0">
            <Link className="rounded-md border border-[#EEE5E0] px-4 py-2.5 text-sm font-semibold text-[#756B80] hover:border-[#29213D]" href="/dashboard">Cancel</Link>
            <button className="rounded-md bg-[#642BD8] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#5322B5] disabled:cursor-not-allowed disabled:opacity-60 sm:py-2.5" disabled={saving} type="submit">
              {saving ? "Generating syllabus..." : savedGoalId ? "Retry syllabus generation" : "Save & Generate Syllabus"}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
