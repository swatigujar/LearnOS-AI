"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { selectScenarioCourse, type ScenarioCourseSelection } from "@/lib/scenario-practice";
import { cleanScenarioHistoryText, scenarioHistoryTitle } from "@/lib/practice-display";
import { GeneratedPracticeSession, type GeneratedSession } from "@/components/generated-practice-session";
import { Select } from "@/components/ui/select";

type Course = { courseId: string; title: string; syllabusStatus: "ready" | "not_generated" | "generating" | "failed" | "unavailable" };
type Topic = { topicId: string; title: string; moduleTitle: string; syllabusVersion: number };
type Attempt = { attemptId: string; courseTitle: string; topicTitle: string; difficulty: string; completedAt: string | null; mode: string; category: string | null };
type LegacyReview = { mode: "scenario"; title: string; category: string; response: string; referenceAnswer: string; explanation: string; checklist: { id: string; label: string; selected: boolean }[]; suggestedNextSteps: string[]; forRevision: boolean };
type GeneratedReview = { mode: "scenario"; total: number; scoreable: number; correct: number; incorrect: number; unanswered: number; percentage: number | null; questions: { questionId: string; prompt: string; scenarioTitle?: string | null; scenarioContext?: string | null; scenarioTask?: string | null; selectedAnswer: string | number | null; expectedAnswer: string; rubric: string[]; explanation: string; suggestedNextSteps: string[] }[] };
type ScenarioReview = LegacyReview | GeneratedReview;

async function requestJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 404) throw new Error("The requested course information is unavailable. Refresh and try again.");
    if (response.status >= 500) throw new Error("Practice is temporarily unavailable. Please retry.");
    throw new Error(typeof data.detail === "string" ? data.detail : "Practice is unavailable. Please try again.");
  }
  return data as T;
}

export function ScenarioPractice() {
  const { user } = useAuth();
  return <ScenarioPracticeForUser key={user?.uid ?? "signed-out"} user={user} />;
}

function ScenarioPracticeForUser({ user }: { user: NonNullable<ReturnType<typeof useAuth>["user"]> | null }) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [selection, setSelection] = useState<ScenarioCourseSelection>(() => selectScenarioCourse(""));
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [topicError, setTopicError] = useState("");
  const [reloadTopics, setReloadTopics] = useState(0);
  const [difficulty, setDifficulty] = useState("Medium");
  const [count, setCount] = useState(3);
  const [session, setSession] = useState<GeneratedSession | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [review, setReview] = useState<ScenarioReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const fetchAsUser = useCallback(async <T,>(url: string, init?: RequestInit) => {
    if (!user) throw new Error("Sign in to use Scenario Practice.");
    const token = await user.getIdToken();
    return requestJson<T>(await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) }, cache: "no-store" }));
  }, [user]);

  const refreshHistory = useCallback(async () => {
    if (!user) return;
    try {
      const data = await fetchAsUser<{ attempts: Attempt[] }>("/api/practice?action=attempts");
      setAttempts(data.attempts.filter((item) => item.mode === "scenario").slice(0, 10));
      setHistoryError("");
    } catch (historyLoadError) {
      setHistoryError(historyLoadError instanceof Error ? historyLoadError.message : "Practice history could not be loaded.");
    }
  }, [fetchAsUser, user]);

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const catalog = await fetchAsUser<{ courses: Course[] }>("/api/practice?action=courseCatalog");
      setCourses(catalog.courses);
      await refreshHistory();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Your courses could not be loaded.");
    } finally { setLoading(false); }
  }, [fetchAsUser, refreshHistory, user]);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  const selectedCourse = courses.find((course) => course.courseId === selection.courseId);
  useEffect(() => {
    if (!user || !selectedCourse || selectedCourse.syllabusStatus !== "ready") {
      return;
    }
    let active = true;
    void Promise.resolve().then(() => {
      if (active) setTopicsLoading(true);
      return fetchAsUser<{ topics: Topic[] }>(`/api/practice?action=courseTopics&courseId=${encodeURIComponent(selectedCourse.courseId)}`);
    })
      .then((data) => { if (active) setTopics(data.topics); })
      .catch((loadError: unknown) => { if (active) setTopicError(loadError instanceof Error ? loadError.message : "Topics could not be loaded."); })
      .finally(() => { if (active) setTopicsLoading(false); });
    return () => { active = false; };
  }, [fetchAsUser, reloadTopics, selectedCourse, user]);

  const visibleTopics = useMemo(() => selectedCourse?.syllabusStatus === "ready" ? topics : [], [selectedCourse, topics]);
  const selectedTopic = visibleTopics.find((topic) => topic.topicId === selection.topicId);

  const generate = async () => {
    if (!selectedCourse || !selectedTopic || busy) return;
    setBusy(true); setError(""); setReview(null);
    try {
      const data = await fetchAsUser<GeneratedSession>("/api/practice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "generate", mode: "scenario", courseId: selectedCourse.courseId, topicId: selectedTopic.topicId, syllabusVersion: selectedTopic.syllabusVersion, difficulty, questionCount: count, questionFormat: "short_answer" }) });
      setSession(data);
    } catch (generationError) { setError(generationError instanceof Error ? generationError.message : "Scenario set could not be prepared."); }
    finally { setBusy(false); }
  };

  const reviewAttempt = async (attemptId: string) => {
    setError("");
    try {
      const data = await fetchAsUser<ScenarioReview>(`/api/practice?action=attemptDetail&attemptId=${encodeURIComponent(attemptId)}`);
      setReview(data); setSession(null);
    } catch (reviewError) { setError(reviewError instanceof Error ? reviewError.message : "Attempt review is unavailable."); }
  };

  if (session) return <div className="min-w-0 space-y-4"><GeneratedPracticeSession session={session} onExit={() => setSession(null)} onAttemptSaved={refreshHistory}/><ScenarioHistory attempts={attempts} error={historyError} onReview={(id) => void reviewAttempt(id)} onRefresh={() => void refreshHistory()}/></div>;

  return <div className="min-w-0 space-y-4">
    {error && <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{error}</p>}
    <section aria-labelledby="scenario-setup-title" className="rounded-xl border border-[#EEE5E0] bg-white p-4 shadow-sm sm:p-5">
      <div className="max-w-2xl">
        <p className="text-xs font-bold uppercase tracking-wide text-[#642BD8]">Scenario-Based Practice</p>
        <h3 className="mt-1 text-lg font-semibold text-[#4A285F]" id="scenario-setup-title">Build a scenario set from your syllabus</h3>
        <p className="mt-1 text-sm leading-5 text-[#756B80]">Choose a course and topic. Reference answers are for self-review; responses are not automatically graded.</p>
      </div>

      {!user ? <p className="mt-4 rounded-md bg-[#F2ECFF] p-3 text-sm text-[#756B80]">Sign in to practice from your saved courses.</p>
        : loading ? <p className="mt-4 text-sm text-[#756B80]" role="status">Loading your courses…</p>
          : error && !courses.length ? <div className="mt-4"><button className="text-sm font-semibold text-[#642BD8] underline" onClick={() => void load()} type="button">Retry loading courses</button></div>
            : courses.length === 0 ? <div className="mt-4 rounded-md bg-[#F2ECFF] p-4"><p className="text-sm text-[#756B80]">No active courses are available yet.</p><Link className="mt-2 inline-flex text-sm font-semibold text-[#642BD8] underline" href="/dashboard/new">Create a course</Link></div>
              : <div className="mt-4 space-y-4">
                <div className="block min-w-0 max-w-2xl text-sm font-semibold text-[#31463b]">1. Select course
                  <Select className="mt-1.5" label="Select course" onValueChange={(courseId) => { const nextCourse = courses.find((course) => course.courseId === courseId); setSelection(selectScenarioCourse(courseId)); setTopics([]); setTopicError(""); setTopicsLoading(nextCourse?.syllabusStatus === "ready"); setReview(null); setError(""); }} options={[{ value: "", label: "Choose one of your courses" }, ...courses.map((course) => ({ value: course.courseId, label: course.title }))]} value={selection.courseId} />
                </div>

                {selectedCourse && selectedCourse.syllabusStatus !== "ready" && <div className="max-w-2xl rounded-md bg-[#F2ECFF] px-3 py-3 text-sm leading-5 text-[#756B80]" role="status">
                  <p>{syllabusMessage(selectedCourse.syllabusStatus)}</p>
                  {selectedCourse.syllabusStatus === "generating" && <button className="mt-2 font-semibold text-[#642BD8] underline" onClick={() => void load()} type="button">Refresh course status</button>}
                  {selectedCourse.syllabusStatus !== "generating" && <Link className="mt-2 inline-flex font-semibold text-[#642BD8] underline" href={`/dashboard/courses/${encodeURIComponent(selectedCourse.courseId)}`}>Open course syllabus</Link>}
                </div>}

                {selectedCourse?.syllabusStatus === "ready" && <>
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="min-w-0 text-sm font-medium text-[#31463b]">2. Select topic
                      <Select className="mt-1.5" label="Select topic" disabled={topicsLoading || !!topicError || !visibleTopics.length} onValueChange={(topicId) => { setSelection((current) => ({ ...current, topicId })); setReview(null); }} options={[{ value: "", label: topicsLoading ? "Loading syllabus topics…" : visibleTopics.length ? "Choose a topic" : "No topics available" }, ...visibleTopics.map((topic) => ({ value: topic.topicId, label: `${topic.moduleTitle} · ${topic.title}` }))]} value={selection.topicId} />
                    </div>
                    <label className="min-w-0 text-sm font-medium text-[#31463b]">3. Difficulty
                      <Select className="mt-1.5" label="Difficulty" onValueChange={setDifficulty} options={["Easy", "Medium", "Hard"].map((item) => ({ value: item, label: item }))} value={difficulty} />
                    </label>
                    <label className="min-w-0 text-sm font-medium text-[#31463b]">4. Number of scenarios
                      <Select className="mt-1.5" label="Number of scenarios" onValueChange={(value) => setCount(Number(value))} options={[3, 5, 8].map((item) => ({ value: String(item), label: `${item} scenarios` }))} value={String(count)} />
                    </label>
                  </div>
                  {topicsLoading && <p className="text-sm text-[#756B80]" role="status">Loading topics from this saved syllabus…</p>}
                  {topicError && <div className="text-sm text-red-800" role="alert"><p>{topicError}</p><button className="mt-1 font-semibold underline" onClick={() => { setTopicError(""); setTopicsLoading(true); setReloadTopics((value) => value + 1); }} type="button">Retry topic loading</button></div>}
                  {!topicsLoading && !topicError && visibleTopics.length === 0 && <p className="rounded-md bg-[#F2ECFF] px-3 py-2 text-sm text-[#756B80]" role="status">This saved syllabus has no topics available for practice.</p>}
                  <div className="flex flex-wrap items-center gap-3 border-t border-[#EEE5E0] pt-4">
                    <button className="min-h-11 rounded-md bg-[#642BD8] px-4 py-2 text-sm font-semibold text-white hover:bg-[#5322B5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8] disabled:cursor-not-allowed disabled:opacity-50" disabled={busy || topicsLoading || !!topicError || !selectedTopic} onClick={() => void generate()} type="button">{busy ? "Preparing scenarios…" : "Generate scenarios"}</button>
                    <p className="text-xs text-[#756B80]">Generation uses the configured provider only when requested; matching sets are cached to your account.</p>
                  </div>
                </>}
              </div>}
    </section>
    {review && ("questions" in review ? <GeneratedScenarioReview review={review} onClose={() => setReview(null)}/> : <LegacyScenarioReview review={review} onClose={() => setReview(null)}/>)}
    {!session && <ScenarioHistory attempts={attempts} error={historyError} onReview={(id) => void reviewAttempt(id)} onRefresh={() => void refreshHistory()}/>}
  </div>;
}

function syllabusMessage(status: Course["syllabusStatus"]) {
  if (status === "generating") return "This course syllabus is still being prepared. Refresh the course after generation finishes.";
  if (status === "failed") return "This course syllabus could not be generated. Open the course to retry syllabus creation.";
  if (status === "unavailable") return "The saved syllabus for this course is unavailable. Open the course to review or regenerate it.";
  return "This course has no saved syllabus yet. Create a syllabus to choose a scenario topic.";
}

function formatPracticeDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function ScenarioHistory({ attempts, error, onReview, onRefresh }: { attempts: Attempt[]; error: string; onReview: (id: string) => void; onRefresh: () => void }) {
  return <section className="learnos-card min-w-0 p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="text-xs font-bold uppercase tracking-wide text-[#642BD8]">Your practice</p><h3 className="mt-1 font-semibold text-[#4A285F]">Recent scenario attempts</h3></div><button className="min-h-9 shrink-0 rounded-md border border-[#E2D6ED] px-3 text-sm font-semibold text-[#642BD8] hover:bg-[#F2ECFF]" onClick={onRefresh} type="button">Refresh</button></div>
    {error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
    {attempts.length ? <ul className="mt-2 divide-y divide-[#EEE5E0]">{attempts.map((item) => {
      const title = scenarioHistoryTitle(item.courseTitle, item.topicTitle);
      const difficulty = cleanScenarioHistoryText(item.difficulty)
        .replace(/\s*\u00b7\s*descriptive(?:\s+self-review)?$/i, "") || "Practice";
      const date = formatPracticeDate(item.completedAt);
      return <li className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3" key={item.attemptId}>
        <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium text-[#31463b]">{title}</span><span className="flex flex-wrap gap-x-2 text-xs text-[#756B80]"><span>{difficulty}</span>{date && <span>{date}</span>}<span>Descriptive self-review</span></span></span>
        <button className="min-h-9 shrink-0 rounded-md border border-[#E2D6ED] px-3 py-1.5 text-sm font-semibold text-[#642BD8]" onClick={() => onReview(item.attemptId)} type="button">Review</button>
      </li>;
    })}</ul> : !error && <p className="mt-3 text-sm text-[#756B80]">No saved scenario attempts yet.</p>}
  </section>;
}

function LegacyScenarioReview({ review, onClose }: { review: LegacyReview; onClose: () => void }) {
  return <section className="learnos-card p-5 sm:p-6"><p className="text-xs font-bold uppercase tracking-wide text-[#642BD8]">Saved reference review · {review.category}</p><h3 className="mt-1 break-words text-xl font-semibold">{review.title}</h3><p className="mt-4 text-sm font-semibold">Your response</p><p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-[#F2ECFF] p-3 text-sm leading-6">{review.response}</p><p className="mt-4 font-semibold">Reference answer</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{review.referenceAnswer}</p><p className="mt-3 text-sm leading-6 text-[#756B80]">{review.explanation}</p><h4 className="mt-4 font-semibold">Self-check checklist</h4><ul className="mt-2 space-y-2">{review.checklist.map((item) => <li className="flex gap-2 text-sm leading-5" key={item.id}><span aria-hidden="true">{item.selected ? "✓" : "○"}</span>{item.label}</li>)}</ul><h4 className="mt-4 font-semibold">Suggested next steps</h4><ul className="mt-2 list-inside list-disc space-y-1 text-sm leading-5">{review.suggestedNextSteps.map((step) => <li key={step}>{step}</li>)}</ul><p className="mt-4 text-sm text-[#756B80]">{review.forRevision ? "Marked for revision." : "Not marked for revision."} This is a reference checklist, not automated grading.</p><button className="mt-4 rounded-md border border-[#E2D6ED] px-4 py-2 text-sm font-semibold text-[#642BD8]" onClick={onClose} type="button">Back to scenario setup</button></section>;
}

function GeneratedScenarioReview({ review, onClose }: { review: GeneratedReview; onClose: () => void }) {
  return <section className="learnos-card p-5 sm:p-6"><p className="text-xs font-bold uppercase tracking-wide text-[#642BD8]">Saved scenario self-review</p><h3 className="mt-1 text-xl font-semibold text-[#4A285F]">{review.total} scenario{review.total === 1 ? "" : "s"} reviewed</h3><p className="mt-2 text-sm text-[#756B80]">{review.correct} correct · {review.incorrect} incorrect · {review.unanswered} unanswered · descriptive responses are not automatically graded</p><ol className="mt-4 space-y-3">{review.questions.map((item, index) => <li className="rounded-md border border-[#EEE5E0] p-4" key={item.questionId}><p className="text-xs font-semibold text-[#756B80]">Scenario {index + 1}</p>{item.scenarioTitle && <h4 className="mt-1 font-semibold">{item.scenarioTitle}</h4>}{item.scenarioContext && <p className="mt-2 whitespace-pre-wrap rounded-md bg-[#F2ECFF] p-3 text-sm leading-6">{item.scenarioContext}</p>}<p className="mt-3 font-medium">{item.scenarioTask || item.prompt}</p><p className="mt-2 text-sm font-semibold">Your response</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{typeof item.selectedAnswer === "string" && item.selectedAnswer.trim() ? item.selectedAnswer : "Not answered"}</p><p className="mt-3 text-sm font-semibold text-[#642BD8]">Reference answer</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{item.expectedAnswer}</p><ul className="mt-2 list-inside list-disc space-y-1 text-sm leading-5 text-[#756B80]">{item.rubric.map((line) => <li key={line}>{line}</li>)}</ul><p className="mt-3 text-sm leading-6 text-[#756B80]">{item.explanation}</p><ul className="mt-2 list-inside list-disc space-y-1 text-sm leading-5">{item.suggestedNextSteps.map((step) => <li key={step}>{step}</li>)}</ul></li>)}</ol><button className="mt-4 rounded-md border border-[#E2D6ED] px-4 py-2 text-sm font-semibold text-[#642BD8]" onClick={onClose} type="button">Back to scenario setup</button></section>;
}
