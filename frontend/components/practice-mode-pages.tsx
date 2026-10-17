"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { GeneratedPracticeSession, type GeneratedSession } from "@/components/generated-practice-session";
import { Select } from "@/components/ui/select";

type Difficulty = "Easy" | "Medium" | "Hard";
type InterviewCategory = string;
type InterviewQuestion = { questionId: string; category: InterviewCategory; difficulty: Difficulty; kind: "mcq" | "descriptive"; prompt: string; options: string[] };
type InterviewCatalog = { categories: { category: InterviewCategory; difficulties: Difficulty[]; questionCount: number; questionCounts?: Partial<Record<Difficulty, number>> }[] };
type InterviewCheck = { questionId: string; kind: "mcq" | "descriptive"; correct: boolean | null; expectedAnswer: string; explanation: string };
type InterviewReviewQuestion = InterviewQuestion & { selectedAnswer: string | number | null; expectedAnswer: string; explanation: string; correct: boolean | null; forRevision: boolean };
type InterviewResult = { attemptId: string; mode: "interview"; category: InterviewCategory; difficulty: Difficulty; total: number; scoreable: number; answered: number; correct: number; incorrect: number; unanswered: number; percentage: number | null; revisionCount: number; questions: InterviewReviewQuestion[] };
type Attempt = { attemptId: string; courseTitle: string; topicTitle: string; difficulty: string; percentage: number; correct: number; total: number; completedAt: string | null; mode: "concept" | "interview" | "scenario"; category: string | null; revisionCount: number };
type SavedTopic = { courseId: string; courseTitle: string; moduleTitle: string; topicId: string; title: string; syllabusVersion: number };

function availableQuestionCount(counts: Partial<Record<Difficulty, number>> | undefined, difficulty: string) {
  const count = counts?.[difficulty as Difficulty];
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

async function requestJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Practice is unavailable. Please try again.");
  return data as T;
}

async function practiceFetch<T>(user: NonNullable<ReturnType<typeof useAuth>["user"]>, url: string, init?: RequestInit) {
  const token = await user.getIdToken();
  return requestJson<T>(await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    cache: "no-store",
  }));
}

function usePracticeHistory() {
  const { user } = useAuth();
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [historyError, setHistoryError] = useState("");
  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const data = await practiceFetch<{ attempts: Attempt[] }>(user, "/api/practice?action=attempts");
      setAttempts(data.attempts);
      setHistoryError("");
    } catch (error) { setHistoryError(error instanceof Error ? error.message : "Practice history is unavailable."); }
  }, [user]);
  useEffect(() => { const timer = window.setTimeout(() => { void refresh(); }, 0); return () => window.clearTimeout(timer); }, [refresh]);
  return { attempts, historyError, refresh };
}

export function InterviewPractice() {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState<InterviewCatalog["categories"]>([]);
  const [category, setCategory] = useState<InterviewCategory | "custom" | "">("");
  const [customSkill, setCustomSkill] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty | "">("");
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  const [checked, setChecked] = useState<Record<string, InterviewCheck>>({});
  const [revisionIds, setRevisionIds] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<InterviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { attempts, historyError, refresh } = usePracticeHistory();
  const [historyReview, setHistoryReview] = useState<InterviewResult | null>(null);
  const [generatedSession, setGeneratedSession] = useState<GeneratedSession | null>(null);
  const [sessionLength, setSessionLength] = useState(5);
  const [targetRole, setTargetRole] = useState("");
  const [savedTopics, setSavedTopics] = useState<SavedTopic[]>([]);
  const [contextTopicKey, setContextTopicKey] = useState("");
  const [contextLoadError, setContextLoadError] = useState("");
  const categoryInfo = catalog.find((item) => item.category === category);
  const interviewFocus = category === "custom" ? customSkill.trim() : category;
  const current = questions[index];

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true); setError("");
    try {
      const data = await practiceFetch<InterviewCatalog>(user, "/api/practice?action=interviewCatalog");
      setCatalog(data.categories);
      setCategory((selected) => data.categories.some((item) => item.category === selected) ? selected : data.categories[0]?.category ?? "");
      setDifficulty((selected) => data.categories.some((item) => item.category === category && item.difficulties.includes(selected as Difficulty)) ? selected : data.categories[0]?.difficulties[0] ?? "");
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Interview questions could not be loaded."); }
    finally { setLoading(false); }
  }, [category, user]);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void practiceFetch<{ topics: SavedTopic[] }>(user, "/api/practice?action=courses").then((data) => {
      if (!active) return;
      setSavedTopics(data.topics);
      setContextTopicKey((currentKey) => data.topics.some((topic) => `${topic.courseId}:${topic.topicId}` === currentKey) ? currentKey : "");
      setContextLoadError("");
    }).catch((contextError: unknown) => { if (active) setContextLoadError(contextError instanceof Error ? contextError.message : "Saved course context could not be loaded."); });
    return () => { active = false; };
  }, [user]);

  const start = async () => {
    if (!user || !category || category === "custom" || !difficulty) return;
    setBusy(true); setError("");
    try {
      const query = new URLSearchParams({ action: "interviewQuestions", category, difficulty });
      const data = await practiceFetch<{ questions: InterviewQuestion[] }>(user, `/api/practice?${query}`);
      setQuestions(data.questions); setAnswers({}); setChecked({}); setRevisionIds([]); setIndex(0); setResult(null); setHistoryReview(null);
      if (!data.questions.length) setError("There are no questions for this category and difficulty yet.");
    } catch (startError) { setError(startError instanceof Error ? startError.message : "Questions could not be loaded."); }
    finally { setBusy(false); }
  };

  const checkAnswer = async () => {
    if (!user || !current || answers[current.questionId] === undefined || !category || !difficulty) return;
    setBusy(true); setError("");
    try {
      const data = await practiceFetch<InterviewCheck>(user, "/api/practice", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "interviewCheck", category, difficulty, questionId: current.questionId, answer: answers[current.questionId] }) });
      setChecked((value) => ({ ...value, [current.questionId]: data }));
    } catch (checkError) { setError(checkError instanceof Error ? checkError.message : "Your answer could not be checked."); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    if (!user || !category || !difficulty) return;
    setBusy(true); setError("");
    try {
      const data = await practiceFetch<InterviewResult>(user, "/api/practice", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "interviewSubmit", category, difficulty, answers, revisionQuestionIds: revisionIds }) });
      setResult(data); setQuestions([]); setHistoryReview(null); await refresh();
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "Your attempt could not be saved."); }
    finally { setBusy(false); }
  };

  const generate = async () => {
    if (!user || !interviewFocus || !difficulty || busy) return;
    setBusy(true); setError("");
    try {
      const contextTopic = savedTopics.find((topic) => `${topic.courseId}:${topic.topicId}` === contextTopicKey);
      const data = await practiceFetch<GeneratedSession>(user, "/api/practice", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", mode: "interview", category: interviewFocus, targetRole, difficulty, questionCount: sessionLength, questionFormat: "mixed", ...(contextTopic ? { courseId: contextTopic.courseId, topicId: contextTopic.topicId, syllabusVersion: contextTopic.syllabusVersion } : {}) }) });
      setGeneratedSession(data); setQuestions([]); setResult(null); setHistoryReview(null);
    } catch (generationError) { setError(generationError instanceof Error ? generationError.message : "Interview questions could not be generated."); }
    finally { setBusy(false); }
  };

  const reviewAttempt = async (attemptId: string) => {
    if (!user) return;
    setError("");
    try { setHistoryReview(await practiceFetch<InterviewResult>(user, `/api/practice?action=attemptDetail&attemptId=${encodeURIComponent(attemptId)}`)); }
    catch (reviewError) { setError(reviewError instanceof Error ? reviewError.message : "Attempt review is unavailable."); }
  };

  const toggleRevision = (questionId: string) => setRevisionIds((ids) => ids.includes(questionId) ? ids.filter((id) => id !== questionId) : [...ids, questionId]);
  const review = result ?? historyReview;

  if (generatedSession) return <div className="space-y-5"><GeneratedPracticeSession session={generatedSession} onExit={() => setGeneratedSession(null)} onAttemptSaved={refresh}/><HistoryList mode="interview" attempts={attempts} error={historyError} onReview={(id) => void reviewAttempt(id)} onRefresh={() => void refresh()} /></div>;

  return <div className="space-y-5">
    {error && <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{error}</p>}
    {loading ? <p className="rounded-lg border border-[#e0e2d9] bg-white p-5 text-sm text-[#68736d]" role="status">Loading interview question categoriesΓÇª</p> : catalog.length === 0 ? <div className="rounded-lg border border-[#e0e2d9] bg-white p-5"><h3 className="font-semibold">No interview questions are available</h3><p className="mt-1 text-sm text-[#68736d]">The static question bank is currently empty.</p><button className="mt-3 text-sm font-semibold text-[#176b59] underline" onClick={() => void load()} type="button">Retry</button></div> : null}
    {!loading && !result && !historyReview && !current && <section className="rounded-xl border border-[#dce3db] bg-white p-5 sm:p-6"><h3 className="font-semibold">Choose an interview skill</h3><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Reviewed category or generated focus<Select className="mt-2" label="Reviewed category or generated focus" onValueChange={(categoryValue) => { if (categoryValue === "custom") { setCategory("custom"); setDifficulty("Easy"); return; } const next = catalog.find((item) => item.category === categoryValue); setCategory(categoryValue); setDifficulty(next?.difficulties[0] ?? "Easy"); }} options={[...catalog.map((item) => ({ value: item.category, label: item.category + " - " + item.questionCount + " reviewed bank questions" })), { value: "custom", label: "Enter another skill" }]} value={category} /></label>{category === "custom" && <label className="text-sm font-medium">Skill or interview focus<input className="mt-2 block min-h-11 w-full rounded-md border border-[#d9ddd5] px-3 py-2" maxLength={80} onChange={(event) => setCustomSkill(event.target.value)} placeholder="Enter a skill area" value={customSkill}/></label>}<label className="text-sm font-medium">Difficulty<Select className="mt-2" label="Difficulty" onValueChange={(level) => setDifficulty(level as Difficulty)} options={(categoryInfo?.difficulties ?? ["Easy", "Medium", "Hard"]).map((level) => ({ value: level, label: level }))} value={difficulty} /></label><label className="text-sm font-medium">Target role (optional)<input className="mt-2 block min-h-11 w-full rounded-md border border-[#d9ddd5] px-3 py-2" maxLength={200} onChange={(event) => setTargetRole(event.target.value)} placeholder="e.g. QA automation engineer" value={targetRole}/></label><label className="text-sm font-medium">Saved syllabus context (optional)<Select className="mt-2" label="Saved syllabus context" onValueChange={setContextTopicKey} options={[{ value: "", label: "No course context" }, ...savedTopics.map((topic) => ({ value: topic.courseId + ":" + topic.topicId, label: topic.courseTitle + " / " + topic.moduleTitle + " / " + topic.title }))]} value={contextTopicKey} /></label><label className="text-sm font-medium">Generated session length<Select className="mt-2" label="Generated session length" onValueChange={(length) => setSessionLength(Number(length))} options={[3, 5, 10].map((length) => ({ value: String(length), label: length + " questions" }))} value={String(sessionLength)} /></label></div>{contextLoadError && <p className="mt-2 text-xs text-[#9b3b2b]" role="status">Saved course context could not be loaded; interview generation can continue without it.</p>}{categoryInfo && difficulty && <p className="mt-2 text-xs text-[#68736d]">{availableQuestionCount(categoryInfo.questionCounts, difficulty)} reviewed questions are available at this difficulty.</p>}{category === "custom" && <p className="mt-2 text-xs text-[#68736d]">No reviewed bank is claimed for a custom skill. Generate a set to request skill-specific questions.</p>}<p className="mt-2 text-xs text-[#68736d]">The reviewed bank and generated interview sessions are separate. Generated questions use Gemini quota only when requested and are cached for matching context.</p><div className="mt-4 flex flex-wrap gap-3"><button className="min-h-11 rounded-md border border-[#cbd8d0] px-4 py-2 text-sm font-semibold text-[#176b59] disabled:opacity-50" disabled={busy || !category || category === "custom" || !difficulty || availableQuestionCount(categoryInfo?.questionCounts, difficulty) === 0} onClick={() => void start()} type="button">{busy ? "LoadingΓÇª" : "Start reviewed interview"}</button><button className="min-h-11 rounded-md bg-[#176b59] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !interviewFocus || !difficulty} onClick={() => void generate()} type="button">{busy ? "PreparingΓÇª" : "Generate interview set"}</button></div><p className="mt-3 text-xs text-[#68736d]">Descriptive responses are compared with sample answers and are not automatically graded.</p></section>}
    {current && <section className="rounded-xl border border-[#dce3db] bg-white p-5 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-[#68736d]">{category} ┬╖ {difficulty}</p><p className="text-sm font-semibold text-[#176b59]">Question {index + 1} of {questions.length}</p></div><progress aria-label={`Question ${index + 1} of ${questions.length}`} className="mt-3 block h-1.5 w-full accent-[#176b59]" max={questions.length} value={index + 1}/><h3 className="mt-5 break-words font-semibold leading-6">{current.prompt}</h3>{current.kind === "mcq" ? <fieldset className="mt-4 space-y-2"><legend className="sr-only">Answer options</legend>{current.options.map((option, optionIndex) => <label className="flex cursor-pointer items-start gap-3 rounded-md border border-[#e0e5de] p-3 text-sm hover:bg-[#f6f8f5]" key={optionIndex}><input checked={answers[current.questionId] === optionIndex} className="mt-1 accent-[#176b59]" name={current.questionId} onChange={() => { setAnswers((old) => ({ ...old, [current.questionId]: optionIndex })); setChecked((old) => { const next = { ...old }; delete next[current.questionId]; return next; }); }} type="radio"/><span className="break-words">{option}</span></label>)}</fieldset> : <textarea className="mt-4 min-h-36 w-full rounded-md border border-[#d9ddd5] p-3 text-sm leading-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59]" aria-label="Your descriptive answer" maxLength={6000} onChange={(event) => { setAnswers((old) => ({ ...old, [current.questionId]: event.target.value })); setChecked((old) => { const next = { ...old }; delete next[current.questionId]; return next; }); }} placeholder="Write your answerΓÇª" value={typeof answers[current.questionId] === "string" ? answers[current.questionId] as string : ""}/>}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><button className="text-sm font-semibold text-[#176b59] underline" onClick={() => toggleRevision(current.questionId)} type="button">{revisionIds.includes(current.questionId) ? "Marked for revision" : "Mark for revision"}</button><button className="min-h-10 rounded-md border border-[#cbd8d0] px-3 py-2 text-sm font-semibold text-[#176b59] disabled:opacity-50" disabled={busy || answers[current.questionId] === undefined || typeof answers[current.questionId] === "string" && !String(answers[current.questionId]).trim()} onClick={() => void checkAnswer()} type="button">{busy ? "CheckingΓÇª" : checked[current.questionId] ? "Check again" : "Check answer"}</button></div>
      {checked[current.questionId] && <div className="mt-4 rounded-md bg-[#f1f7f3] p-4" role="status"><p className="font-semibold text-[#176b59]">{checked[current.questionId].kind === "descriptive" ? "Sample answer" : checked[current.questionId].correct ? "Correct" : "Review this answer"}</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{checked[current.questionId].expectedAnswer}</p><p className="mt-2 text-sm leading-6 text-[#52645b]">{checked[current.questionId].explanation}</p></div>}
      <div className="mt-5 flex flex-wrap justify-between gap-3 border-t border-[#edf0ec] pt-4"><button className="min-h-10 rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-45" disabled={index === 0} onClick={() => setIndex((old) => old - 1)} type="button">Previous</button>{index < questions.length - 1 ? <button className="min-h-10 rounded-md bg-[#176b59] px-4 py-2 text-sm font-semibold text-white" onClick={() => setIndex((old) => old + 1)} type="button">Next</button> : <button className="min-h-10 rounded-md bg-[#176b59] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => void submit()} type="button">{busy ? "SavingΓÇª" : "Finish and review"}</button>}</div></section>}
    {review && <section className="rounded-xl border border-[#dce3db] bg-white p-5 sm:p-6"><p className="text-xs font-bold uppercase tracking-wide text-[#176b59]">Interview practice summary ┬╖ {review.category}</p><h3 className="mt-1 text-xl font-semibold">{review.percentage === null ? "Descriptive practice complete" : `${review.percentage}% on ${review.scoreable} scored question${review.scoreable === 1 ? "" : "s"}`}</h3><p className="mt-2 text-sm text-[#52645b]">{review.correct} correct ┬╖ {review.incorrect} incorrect ┬╖ {review.unanswered} unanswered ┬╖ {review.revisionCount} marked for revision</p><ol className="mt-4 space-y-3">{review.questions.filter((question) => question.kind === "descriptive" || question.correct !== true || question.forRevision).map((question) => <li className="rounded-md border border-[#e0e5de] p-4" key={question.questionId}><p className="text-xs font-semibold text-[#68736d]">{question.correct === true ? "Correct" : question.correct === false ? "Incorrect" : question.selectedAnswer == null || question.selectedAnswer === "" ? "Unanswered" : "Descriptive ┬╖ self-review"}{question.forRevision ? " ┬╖ Marked for revision" : ""}</p><p className="mt-1 font-medium leading-6">{question.prompt}</p><p className="mt-2 text-sm text-[#68736d]">Your response: {question.selectedAnswer == null || question.selectedAnswer === "" ? "Not answered" : typeof question.selectedAnswer === "number" ? question.options[question.selectedAnswer] : question.selectedAnswer}</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#176b59]">{question.kind === "mcq" ? "Expected answer: " : "Sample answer: "}{question.expectedAnswer}</p><p className="mt-2 text-sm leading-6 text-[#52645b]">{question.explanation}</p></li>)}</ol><button className="mt-4 rounded-md border border-[#cbd8d0] px-4 py-2 text-sm font-semibold text-[#176b59]" onClick={() => { setResult(null); setHistoryReview(null); setQuestions([]); }} type="button">Back to categories</button></section>}
    <HistoryList mode="interview" attempts={attempts} error={historyError} onReview={(id) => void reviewAttempt(id)} onRefresh={() => void refresh()} />
  </div>;
}

function HistoryList({ mode, attempts, error, onReview, onRefresh }: { mode: "interview"; attempts: Attempt[]; error: string; onReview: (id: string) => void; onRefresh: () => void }) {
  const relevant = useMemo(() => attempts.filter((attempt) => attempt.mode === mode).slice(0, 10), [attempts, mode]);
  return <section className="rounded-xl border border-[#dce3db] bg-white p-5 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">Recent {mode === "interview" ? "interview" : "scenario"} attempts</h3><button className="text-sm font-semibold text-[#176b59] underline" onClick={onRefresh} type="button">Refresh</button></div>{error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}{relevant.length ? <ul className="mt-3 divide-y divide-[#edf0ec]">{relevant.map((attempt) => <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={attempt.attemptId}><span className="min-w-0"><span className="block break-words text-sm font-medium">{attempt.category ?? attempt.topicTitle} ┬╖ {attempt.topicTitle}</span><span className="text-xs text-[#68736d]">{attempt.revisionCount} marked for revision</span></span><button className="min-h-9 rounded-md border border-[#cbd8d0] px-3 py-1.5 text-sm font-semibold text-[#176b59]" onClick={() => onReview(attempt.attemptId)} type="button">Review</button></li>)}</ul> : !error ? <p className="mt-3 text-sm text-[#68736d]">No saved attempts for this mode yet.</p> : null}</section>;
}
