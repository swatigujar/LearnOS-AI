"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth-context";

type Kind = "mcq" | "short_answer" | "code_prediction" | "debugging";
export type GeneratedSession = {
  setId: string; sessionId: string; mode: "concept" | "interview" | "scenario"; source: "generated" | "cached";
  contextTitle: string; questionCount: number; adaptationNote: string;
  questions: { questionId: string; kind: Kind; prompt: string; options: string[]; difficulty: string; scenarioTitle?: string | null; scenarioContext?: string | null; scenarioTask?: string | null }[];
};
type Result = {
  attemptId: string; total: number; scoreable: number; correct: number; incorrect: number;
  unanswered: number; percentage: number | null;
  questions: { questionId: string; kind: Kind; prompt: string; options: string[];
    selectedAnswer: number | string | null; expectedAnswer: string; rubric: string[];
    explanation: string; correct: boolean | null; scenarioTitle?: string | null; scenarioContext?: string | null; scenarioTask?: string | null; suggestedNextSteps?: string[] }[];
};

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Practice request failed.");
  return data as T;
}

export function GeneratedPracticeSession({ session, onExit, onAttemptSaved }: {
  session: GeneratedSession; onExit: () => void; onAttemptSaved?: () => Promise<void>;
}) {
  const { user } = useAuth();
  const [answers, setAnswers] = useState<Record<string, number | string>>({});
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const current = session.questions[index];

  async function submit() {
    if (!user || busy) return;
    setBusy(true); setError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/practice", { method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generatedSubmit", setId: session.setId, sessionId: session.sessionId, answers }), cache: "no-store" });
      setResult(await responseJson<Result>(response));
      await onAttemptSaved?.();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Your practice attempt could not be saved.");
    } finally { setBusy(false); }
  }

  if (result) return <section className="rounded-xl border border-[#dce3db] bg-white p-5 shadow-sm sm:p-6">
    <p className="text-xs font-bold uppercase tracking-wide text-[#176b59]">{session.mode === "scenario" ? "Scenario" : session.mode === "concept" ? "Concept" : "Interview"} practice review</p>
    <h3 className="mt-2 text-xl font-semibold text-[#19352d]">{session.mode === "scenario" ? "Self-review complete" : result.percentage === null ? "Self-review complete" : result.percentage + "% on " + result.scoreable + " scored questions"}</h3>
    <p className="mt-2 text-sm text-[#52645b]">{result.correct} correct · {result.incorrect} incorrect · {result.unanswered} unanswered</p>
    <p className="mt-1 text-xs text-[#68736d]">Descriptive answers are not automatically graded. Compare them with the sample answers and rubrics.</p>
    <ol className="mt-5 space-y-3">{result.questions.map((item, number) => <li className="rounded-md border border-[#e0e5de] p-4" key={item.questionId}>
      <p className="text-xs font-semibold text-[#68736d]">Question {number + 1} · {item.correct === true ? "Correct" : item.correct === false ? "Incorrect" : item.selectedAnswer == null || item.selectedAnswer === "" ? "Unanswered" : "Self-review"}</p>
      {item.scenarioTitle && <p className="mt-2 break-words font-medium leading-6">{item.scenarioTitle}</p>}
      {item.scenarioContext && <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-[#f6f8f5] p-3 text-sm leading-6">{item.scenarioContext}</p>}
      <p className="mt-2 break-words font-medium leading-6">{item.scenarioTask || item.prompt}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">Your answer: {item.selectedAnswer == null || item.selectedAnswer === "" ? "Not answered" : typeof item.selectedAnswer === "number" ? item.options[item.selectedAnswer] : item.selectedAnswer}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#176b59]">Reference answer: {item.expectedAnswer}</p>
      {item.rubric.length > 0 && <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-[#52645b]">{item.rubric.map((line) => <li key={line}>{line}</li>)}</ul>}
      <p className="mt-2 text-sm leading-6 text-[#52645b]">{item.explanation}</p>
      {item.suggestedNextSteps?.length ? <ul className="mt-2 list-inside list-disc space-y-1 text-sm leading-5 text-[#52645b]">{item.suggestedNextSteps.map((step) => <li key={step}>{step}</li>)}</ul> : null}
    </li>)}</ol>
    <button className="mt-5 min-h-10 rounded-md border border-[#cbd8d0] px-4 py-2 text-sm font-semibold text-[#176b59]" onClick={onExit} type="button">Back to practice setup</button>
  </section>;

  return <section className="rounded-xl border border-[#dce3db] bg-white p-5 shadow-sm sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-[#176b59]">{session.mode === "scenario" ? "Scenario Practice" : session.mode === "concept" ? "Concept Practice" : "Interview Practice"} · {session.source === "cached" ? "Saved question set" : "Generated question set"}</p><h3 className="mt-1 break-words text-lg font-semibold text-[#19352d]">{session.contextTitle}</h3></div><p className="text-sm font-semibold text-[#176b59]">Question {index + 1} of {session.questions.length}</p></div>
    <p className="mt-3 rounded-md bg-[#f1f7f3] px-3 py-2 text-sm leading-6 text-[#52645b]">{session.adaptationNote}</p>
    <progress aria-label={"Question " + (index + 1) + " of " + session.questions.length} className="mt-3 block h-1.5 w-full accent-[#176b59]" max={session.questions.length} value={index + 1}/>
    {current && <>{current.scenarioTitle && <p className="mt-5 break-words text-lg font-semibold text-[#19352d]">{current.scenarioTitle}</p>}{current.scenarioContext && <div className="mt-3 rounded-md bg-[#f6f8f5] p-4"><p className="text-xs font-semibold uppercase tracking-wide text-[#68736d]">Scenario context</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-[#52645b]">{current.scenarioContext}</p></div>}{current.scenarioTask && <div className="mt-4"><p className="font-medium">Your task</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{current.scenarioTask}</p></div>}{!current.scenarioTask && <p className="mt-5 break-words font-medium leading-6">{current.prompt}</p>}{current.kind === "mcq" ? <fieldset className="mt-4 space-y-2"><legend className="sr-only">Answer options</legend>{current.options.map((option, optionIndex) => <label className={"flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm leading-5 " + (answers[current.questionId] === optionIndex ? "border-[#176b59] bg-[#f1f7f3]" : "border-[#e0e5de] hover:bg-[#fafbf9]")} key={optionIndex}><input checked={answers[current.questionId] === optionIndex} className="mt-1 accent-[#176b59]" name={current.questionId} onChange={() => setAnswers((old) => ({ ...old, [current.questionId]: optionIndex }))} type="radio"/><span className="min-w-0 break-words">{option}</span></label>)}</fieldset> : <label className="mt-4 block text-sm font-medium">Your response<textarea aria-label="Your practice response" className="mt-2 min-h-36 w-full rounded-md border border-[#d9ddd5] p-3 text-sm leading-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59]" maxLength={6000} onChange={(event) => setAnswers((old) => ({ ...old, [current.questionId]: event.target.value }))} placeholder="Write your reasoning or answer…" value={typeof answers[current.questionId] === "string" ? answers[current.questionId] as string : ""}/></label>}</>}
    {error && <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{error}</p>}
    <div className="mt-5 flex flex-wrap justify-between gap-3 border-t border-[#edf0ec] pt-4"><button className="min-h-10 rounded-md border border-[#cbd8d0] px-4 py-2 text-sm font-semibold text-[#176b59] disabled:opacity-45" disabled={index === 0 || busy} onClick={() => setIndex((old) => old - 1)} type="button">Previous</button>{index < session.questions.length - 1 ? <button className="min-h-10 rounded-md bg-[#176b59] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={() => setIndex((old) => old + 1)} type="button">Next question</button> : <button className="min-h-10 rounded-md bg-[#176b59] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || !user} onClick={() => void submit()} type="button">{busy ? "Saving…" : "Submit and review"}</button>}</div>
  </section>;
}
