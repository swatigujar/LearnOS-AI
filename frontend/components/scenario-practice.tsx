"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { GeneratedPracticeSession, type GeneratedSession } from "@/components/generated-practice-session";

type Topic = { courseId: string; courseTitle: string; moduleTitle: string; topicId: string; title: string; syllabusVersion: number };
type Attempt = { attemptId: string; courseTitle: string; topicTitle: string; difficulty: string; completedAt: string | null; mode: string; category: string | null };
type LegacyReview = { mode: "scenario"; title: string; category: string; response: string; referenceAnswer: string; explanation: string; checklist: { id: string; label: string; selected: boolean }[]; suggestedNextSteps: string[]; forRevision: boolean };
type GeneratedReview = { mode: "scenario"; total: number; scoreable: number; correct: number; incorrect: number; unanswered: number; percentage: number | null; questions: { questionId: string; prompt: string; scenarioTitle?: string | null; scenarioContext?: string | null; scenarioTask?: string | null; selectedAnswer: string | number | null; expectedAnswer: string; rubric: string[]; explanation: string; suggestedNextSteps: string[] }[] };
type ScenarioReview = LegacyReview | GeneratedReview;

async function requestJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Practice is unavailable. Please try again.");
  return data as T;
}

export function ScenarioPractice() {
  const { user } = useAuth();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
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
    } catch (historyLoadError) { setHistoryError(historyLoadError instanceof Error ? historyLoadError.message : "Practice history could not be loaded."); }
  }, [fetchAsUser, user]);

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const [catalog] = await Promise.all([fetchAsUser<{ topics: Topic[] }>("/api/practice?action=courses"), refreshHistory()]);
      setTopics(catalog.topics);
      setSelectedKey((old) => catalog.topics.some((item) => `${item.courseId}:${item.topicId}` === old) ? old : catalog.topics[0] ? `${catalog.topics[0].courseId}:${catalog.topics[0].topicId}` : "");
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Courses and practice history could not be loaded."); }
    finally { setLoading(false); }
  }, [fetchAsUser, refreshHistory, user]);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  const selected = topics.find((item) => `${item.courseId}:${item.topicId}` === selectedKey);
  const generate = async () => {
    if (!selected || busy) return;
    setBusy(true); setError(""); setReview(null);
    try {
      const data = await fetchAsUser<GeneratedSession>("/api/practice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "generate", mode: "scenario", courseId: selected.courseId, topicId: selected.topicId, syllabusVersion: selected.syllabusVersion, difficulty, questionCount: count, questionFormat: "short_answer" }) });
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

  if (session) return <div className="space-y-5"><GeneratedPracticeSession session={session} onExit={() => setSession(null)} onAttemptSaved={refreshHistory}/><ScenarioHistory attempts={attempts} error={historyError} onReview={(id) => void reviewAttempt(id)} onRefresh={() => void refreshHistory()}/></div>;

  return <div className="space-y-5">
    {error && <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{error}</p>}
    {loading ? <p className="rounded-lg border border-[#e0e2d9] bg-white p-5 text-sm text-[#68736d]" role="status">Loading saved course topics…</p>
      : topics.length === 0 ? <section className="rounded-xl border border-[#dce3db] bg-white p-5 sm:p-6"><h3 className="font-semibold text-[#19352d]">No saved syllabus topics available</h3><p className="mt-2 text-sm leading-6 text-[#68736d]">Scenario Practice uses your active courses and saved syllabus. Create or finish a course syllabus, then retry.</p><button className="mt-3 text-sm font-semibold text-[#176b59] underline focus-visible:outline-2 focus-visible:outline-[#176b59]" onClick={() => void load()} type="button">Retry</button></section>
      : !review && <section className="rounded-xl border border-[#dce3db] bg-white p-5 shadow-sm sm:p-6"><p className="text-xs font-bold uppercase tracking-wide text-[#176b59]">Grounded in your syllabus</p><h3 className="mt-1 text-lg font-semibold text-[#19352d]">Choose a course topic</h3><p className="mt-1 text-sm leading-6 text-[#68736d]">A bounded scenario set is prepared only when requested. Descriptive answers use reference answers and self-review; they are not automatically graded.</p><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="min-w-0 text-sm font-medium">Saved course topic<select className="mt-2 block min-h-11 w-full rounded-md border border-[#d9ddd5] bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59]" onChange={(event) => setSelectedKey(event.target.value)} value={selectedKey}>{topics.map((item) => <option key={`${item.courseId}:${item.topicId}`} value={`${item.courseId}:${item.topicId}`}>{item.courseTitle} · {item.moduleTitle} · {item.title}</option>)}</select></label><label className="text-sm font-medium">Difficulty<select className="mt-2 block min-h-11 w-full rounded-md border border-[#d9ddd5] bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59]" onChange={(event) => setDifficulty(event.target.value)} value={difficulty}>{["Easy", "Medium", "Hard"].map((item) => <option key={item}>{item}</option>)}</select></label><label className="text-sm font-medium">Scenarios requested<select className="mt-2 block min-h-11 w-full rounded-md border border-[#d9ddd5] bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59]" onChange={(event) => setCount(Number(event.target.value))} value={count}>{[3, 5, 8].map((item) => <option key={item} value={item}>{item} scenarios</option>)}</select></label></div><p className="mt-3 break-words text-xs text-[#68736d]">Selected topic: {selected ? `${selected.courseTitle} · ${selected.moduleTitle} · ${selected.title}` : "Choose a topic"}</p><button className="mt-4 min-h-11 rounded-md bg-[#176b59] px-4 py-2 text-sm font-semibold text-white hover:bg-[#125644] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59] disabled:opacity-50" disabled={busy || !selected} onClick={() => void generate()} type="button">{busy ? "Preparing scenarios…" : "Generate scenario set"}</button><p className="mt-2 text-xs text-[#68736d]">Uses the configured question-generation provider only after you select Generate. Matching context is cached privately to your account.</p></section>}
    {review && ("questions" in review ? <GeneratedScenarioReview review={review} onClose={() => setReview(null)}/> : <LegacyScenarioReview review={review} onClose={() => setReview(null)}/>)}
    {!session && <ScenarioHistory attempts={attempts} error={historyError} onReview={(id) => void reviewAttempt(id)} onRefresh={() => void refreshHistory()}/>}
  </div>;
}

function ScenarioHistory({ attempts, error, onReview, onRefresh }: { attempts: Attempt[]; error: string; onReview: (id: string) => void; onRefresh: () => void }) {
  return <section className="rounded-xl border border-[#dce3db] bg-white p-5 sm:p-6"><div className="flex items-center justify-between gap-3"><h3 className="font-semibold text-[#19352d]">Recent scenario attempts</h3><button className="text-sm font-semibold text-[#176b59] underline" onClick={onRefresh} type="button">Refresh</button></div>{error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}{attempts.length ? <ul className="mt-3 divide-y divide-[#edf0ec]">{attempts.map((item) => <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={item.attemptId}><span className="min-w-0"><span className="block break-words text-sm font-medium">{item.courseTitle} · {item.topicTitle}</span><span className="text-xs text-[#68736d]">{item.difficulty}{item.completedAt ? ` · ${new Date(item.completedAt).toLocaleDateString()}` : ""} · descriptive self-review</span></span><button className="min-h-9 rounded-md border border-[#cbd8d0] px-3 py-1.5 text-sm font-semibold text-[#176b59]" onClick={() => onReview(item.attemptId)} type="button">Review</button></li>)}</ul> : !error && <p className="mt-3 text-sm text-[#68736d]">No saved scenario attempts yet.</p>}</section>;
}

function LegacyScenarioReview({ review, onClose }: { review: LegacyReview; onClose: () => void }) {
  return <section className="rounded-xl border border-[#dce3db] bg-white p-5 sm:p-6"><p className="text-xs font-bold uppercase tracking-wide text-[#176b59]">Saved reference review · {review.category}</p><h3 className="mt-1 break-words text-xl font-semibold">{review.title}</h3><p className="mt-4 text-sm font-semibold">Your response</p><p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-[#f6f8f5] p-3 text-sm leading-6">{review.response}</p><p className="mt-4 font-semibold">Reference answer</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{review.referenceAnswer}</p><p className="mt-3 text-sm leading-6 text-[#52645b]">{review.explanation}</p><h4 className="mt-4 font-semibold">Self-check checklist</h4><ul className="mt-2 space-y-2">{review.checklist.map((item) => <li className="flex gap-2 text-sm leading-5" key={item.id}><span aria-hidden="true">{item.selected ? "✓" : "○"}</span>{item.label}</li>)}</ul><h4 className="mt-4 font-semibold">Suggested next steps</h4><ul className="mt-2 list-inside list-disc space-y-1 text-sm leading-5">{review.suggestedNextSteps.map((step) => <li key={step}>{step}</li>)}</ul><p className="mt-4 text-sm text-[#68736d]">{review.forRevision ? "Marked for revision." : "Not marked for revision."} This is a reference checklist, not automated grading.</p><button className="mt-4 rounded-md border border-[#cbd8d0] px-4 py-2 text-sm font-semibold text-[#176b59]" onClick={onClose} type="button">Back to scenario setup</button></section>;
}

function GeneratedScenarioReview({ review, onClose }: { review: GeneratedReview; onClose: () => void }) {
  return <section className="rounded-xl border border-[#dce3db] bg-white p-5 sm:p-6"><p className="text-xs font-bold uppercase tracking-wide text-[#176b59]">Saved scenario self-review</p><h3 className="mt-1 text-xl font-semibold text-[#19352d]">{review.total} scenario{review.total === 1 ? "" : "s"} reviewed</h3><p className="mt-2 text-sm text-[#68736d]">{review.correct} correct · {review.incorrect} incorrect · {review.unanswered} unanswered · descriptive responses are not automatically graded</p><ol className="mt-4 space-y-3">{review.questions.map((item, index) => <li className="rounded-md border border-[#e0e5de] p-4" key={item.questionId}><p className="text-xs font-semibold text-[#68736d]">Scenario {index + 1}</p>{item.scenarioTitle && <h4 className="mt-1 font-semibold">{item.scenarioTitle}</h4>}{item.scenarioContext && <p className="mt-2 whitespace-pre-wrap rounded-md bg-[#f6f8f5] p-3 text-sm leading-6">{item.scenarioContext}</p>}<p className="mt-3 font-medium">{item.scenarioTask || item.prompt}</p><p className="mt-2 text-sm font-semibold">Your response</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{typeof item.selectedAnswer === "string" && item.selectedAnswer.trim() ? item.selectedAnswer : "Not answered"}</p><p className="mt-3 text-sm font-semibold text-[#176b59]">Reference answer</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{item.expectedAnswer}</p><ul className="mt-2 list-inside list-disc space-y-1 text-sm leading-5 text-[#52645b]">{item.rubric.map((line) => <li key={line}>{line}</li>)}</ul><p className="mt-3 text-sm leading-6 text-[#52645b]">{item.explanation}</p><ul className="mt-2 list-inside list-disc space-y-1 text-sm leading-5">{item.suggestedNextSteps.map((step) => <li key={step}>{step}</li>)}</ul></li>)}</ol><button className="mt-4 rounded-md border border-[#cbd8d0] px-4 py-2 text-sm font-semibold text-[#176b59]" onClick={onClose} type="button">Back to scenario setup</button></section>;
}
