"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import { Select } from "@/components/ui/select";
import { requestMock, summarizeMockTopics, type MockBank, type MockResult } from "@/lib/mock-test";

type SavedSyllabus = {
  modules?: { module_id: string; title: string; topics?: { topic_id: string; title: string; description: string }[] }[];
};
type ActiveTest = { attemptId: string; topicId: string; syllabusVersion: number; bank: MockBank | null };

const primary = "rounded-md bg-[#642BD8] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#5322B5] disabled:cursor-not-allowed disabled:opacity-50";
const secondary = "rounded-md border border-[#EEE5E0] px-4 py-2.5 text-sm font-semibold hover:bg-[#F2ECFF] disabled:cursor-not-allowed disabled:opacity-50";

export default function MockTestPage() {
  const { goalId: courseId } = useParams<{ goalId: string }>();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [course, setCourse] = useState({ title: "Saved course", version: 0, ready: false });
  const [syllabus, setSyllabus] = useState<SavedSyllabus | null>(null);
  const [loading, setLoading] = useState(true);
  const [courseError, setCourseError] = useState("");
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [activeTest, setActiveTest] = useState<ActiveTest | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<MockResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempts, setAttempts] = useState<MockResult[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const inFlight = useRef(false);
  const contextKey = useRef("");

  useEffect(() => {
    contextKey.current = `${courseId}:${course.version}`;
    return () => { contextKey.current = ""; };
  }, [courseId, course.version]);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/signin");
  }, [authLoading, router, user]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    let stopSyllabus: (() => void) | undefined;
    const stopCourse = onSnapshot(doc(db, "users", user.uid, "courses", courseId), (snapshot) => {
      stopSyllabus?.();
      if (!snapshot.exists()) {
        setCourseError("This saved course could not be found.");
        setLoading(false);
        return;
      }
      const saved = snapshot.data();
      setCourse({ title: saved.course_name ?? saved.courseName ?? "Saved course",
        version: typeof saved.syllabusVersion === "number" ? saved.syllabusVersion : 0,
        ready: saved.syllabusStatus === "ready" });
      setCourseError("");
      if (saved.syllabusStatus !== "ready" || !(saved.syllabusVersion > 0)) {
        setSyllabus(null);
        setLoading(false);
        return;
      }
      stopSyllabus = onSnapshot(doc(db, "users", user.uid, "courses", courseId, "syllabus", `v${saved.syllabusVersion}`), (snapshot) => {
        if (!active) return;
        setSyllabus(snapshot.exists() ? snapshot.data() as SavedSyllabus : null);
        setCourseError(snapshot.exists() ? "" : "Your saved syllabus could not be loaded. Please return to the course and try again.");
        setLoading(false);
      }, () => {
        if (active) { setCourseError("We couldn't load your syllabus just now. Please refresh in a moment."); setLoading(false); }
      });
    }, () => {
      if (active) { setCourseError("We couldn't connect to your course just now. Please refresh in a moment."); setLoading(false); }
    });
    return () => { active = false; stopCourse(); stopSyllabus?.(); };
  }, [courseId, user]);

  const refreshHistory = useCallback(async () => {
    if (!user) return;
    setHistoryLoading(true);
    try {
      const data = await requestMock<{ attempts: MockResult[] }>(await user.getIdToken(),
        `?action=attempts&courseId=${encodeURIComponent(courseId)}`);
      setAttempts(data.attempts);
      setHistoryError("");
    } catch {
      setHistoryError("We couldn't load your saved results just now. Please try again.");
    } finally { setHistoryLoading(false); }
  }, [courseId, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshHistory(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshHistory]);

  const topics = useMemo(() => (syllabus?.modules ?? []).flatMap((module) =>
    (module.topics ?? []).map((topic) => ({ ...topic, moduleTitle: module.title }))), [syllabus]);
  const topic = topics.find((item) => item.topic_id === selectedTopicId) ?? topics[0];
  const testMatches = activeTest?.syllabusVersion === course.version && activeTest.topicId === topic?.topic_id;
  const questions = testMatches ? activeTest?.bank?.questions ?? [] : [];
  const current = questions[index];
  const activeQuiz = !!testMatches && questions.length > 0 && !result;
  const topicMarks = useMemo(() => summarizeMockTopics(attempts), [attempts]);

  async function prepareTest(checkOnly = false) {
    if (!user || !topic || inFlight.current) return;
    const key = contextKey.current;
    const test: ActiveTest = checkOnly && activeTest ? activeTest : {
      attemptId: crypto.randomUUID(), topicId: topic.topic_id, syllabusVersion: course.version, bank: null,
    };
    inFlight.current = true;
    setBusy(true);
    setError("");
    if (!checkOnly) { setActiveTest(test); setAnswers({}); setIndex(0); setResult(null); }
    try {
      const token = await user.getIdToken();
      const bank = checkOnly
        ? await requestMock<MockBank>(token, `?courseId=${encodeURIComponent(courseId)}&topicId=${encodeURIComponent(test.topicId)}&syllabusVersion=${test.syllabusVersion}&attemptId=${encodeURIComponent(test.attemptId)}`)
        : await requestMock<MockBank>(token, "", {
          action: "start", courseId, topicId: test.topicId, syllabusVersion: test.syllabusVersion, attemptId: test.attemptId,
        });
      if (contextKey.current !== key) return;
      setActiveTest({ ...test, bank });
      if (bank.status === "ready" && !bank.questions.length) throw new Error("Your questions aren't ready yet. Check the saved test again in a moment.");
      if (bank.status === "failed") setError("We couldn't verify this question set, so it won't be used. Please generate a new test.");
      if (bank.status === "missing") setError("This test hasn't been saved yet. Start a new test when you're ready.");
      if (bank.status === "budget_blocked") setError("Question generation is paused by the AI usage limit. Please try again later.");
      if (bank.status === "uncertain") setError("We couldn't confirm whether preparation finished. Check the saved test before generating a new one.");
    } catch (failure) {
      if (contextKey.current === key) setError(failure instanceof Error ? failure.message : "We couldn't prepare your test just now. Please check its saved status.");
    } finally { inFlight.current = false; setBusy(false); }
  }

  async function submitTest() {
    if (!user || !activeTest || !testMatches || inFlight.current) return;
    const key = contextKey.current;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await requestMock<MockResult>(await user.getIdToken(), "", {
        action: "submit", courseId, topicId: activeTest.topicId,
        syllabusVersion: activeTest.syllabusVersion, attemptId: activeTest.attemptId, answers,
      });
      if (contextKey.current !== key) return;
      setResult(saved);
      setAttempts((current) => [saved, ...current.filter((item) => item.attemptId !== saved.attemptId)]);
      void refreshHistory();
    } catch (failure) {
      if (contextKey.current === key) setError(failure instanceof Error ? failure.message : "We couldn't confirm that your result was saved. Your answers are still here. Submit again to safely check and save the same attempt.");
    } finally { inFlight.current = false; setBusy(false); }
  }

  if (authLoading || !user || loading) return <main className="flex min-h-screen items-center justify-center bg-[#FFF8F1] text-sm text-[#756B80]">Loading your saved course...</main>;

  return <main className="min-h-screen bg-[#FFF8F1] px-5 py-8 text-[#29213D] sm:px-8">
    <div className="mx-auto max-w-4xl space-y-5">
      <Link className="text-sm font-semibold text-[#756B80]" href={`/dashboard/courses/${encodeURIComponent(courseId)}`}>Back to course</Link>
      <header><h1 className="text-2xl font-semibold">Mock Test</h1><p className="mt-2 text-sm leading-6 text-[#756B80]">Generate a fresh topic test, review your answers, and track your saved marks.</p></header>
      {courseError ? <p className="rounded-lg border border-[#EEE5E0] bg-[#F2ECFF] p-5 text-sm" role="status">{courseError}</p> : <section className="learnos-card p-5 sm:p-6">
        <h2 className="text-lg font-semibold">Test setup</h2>
        <p className="mt-2 text-sm text-[#756B80]">{course.title} - 10 new multiple-choice questions per test</p>
        {topics.length ? <div className="mt-4">
          <Select label="Lesson or topic" disabled={busy || activeQuiz} options={topics.map((item) => ({
            value: item.topic_id, label: `${item.moduleTitle}: ${item.title}`,
          }))} value={topic?.topic_id ?? ""} onValueChange={(id) => {
            setSelectedTopicId(id); setActiveTest(null); setAnswers({}); setResult(null); setIndex(0); setError("");
          }} />
          <p className="mt-2 text-sm text-[#756B80]">{topic?.description}</p>
        </div> : <p className="mt-3 text-sm text-[#756B80]">A saved, ready syllabus with topics is needed to start.</p>}
        <p className="mt-4 text-sm leading-6 text-[#756B80]">Each new test is generated for your selected topic and checked before use. One mark per correct answer, no negative marks. Unanswered questions earn no marks.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          {!activeQuiz && <button className={primary} disabled={busy || !topic || !course.ready} onClick={() => void prepareTest()} type="button">{busy ? "Preparing and checking questions..." : result ? "Generate new test" : "Start new test"}</button>}
          {testMatches && !result && <button className={secondary} disabled={busy} onClick={() => void prepareTest(true)} type="button">Check saved test</button>}
        </div>
        {busy && <p className="mt-3 text-sm text-[#756B80]" role="status">{activeQuiz ? "Scoring and saving your result..." : "Your questions are being prepared and checked. This may take a moment."}</p>}
        {testMatches && activeTest?.bank?.status === "pending" && <p className="mt-3 text-sm text-[#756B80]" role="status">This test is still being prepared. Use Check saved test in a moment; it will not generate another set.</p>}
        {error && <p className="mt-3 rounded-md bg-[#F2ECFF] p-3 text-sm text-[#4A285F]" role="status">{error}</p>}
      </section>}

      {activeQuiz && current && <section className="learnos-card p-5 sm:p-6" aria-labelledby="question-heading">
        <p className="text-sm text-[#756B80]">Question {index + 1} of {questions.length} - {Object.keys(answers).length} answered</p>
        <fieldset className="mt-4" disabled={busy}><legend className="font-semibold leading-6" id="question-heading">{current.prompt}</legend>
          <div className="mt-4 space-y-2">{current.options.map((option, optionIndex) => <label className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm leading-6 ${answers[current.questionId] === optionIndex ? "border-[#642BD8] bg-[#F2ECFF]" : "border-[#EEE5E0]"}`} key={optionIndex}>
            <input className="mt-1 accent-[#642BD8]" type="radio" name={`answer-${current.questionId}`} checked={answers[current.questionId] === optionIndex} onChange={() => setAnswers((saved) => ({ ...saved, [current.questionId]: optionIndex }))} /><span>{option}</span>
          </label>)}</div>
        </fieldset>
        <div className="mt-5 flex flex-wrap justify-between gap-3">
          <button className={secondary} disabled={busy || index === 0} onClick={() => setIndex((value) => value - 1)} type="button">Previous</button>
          {index < questions.length - 1 ? <button className={primary} disabled={busy} onClick={() => setIndex((value) => value + 1)} type="button">Next</button> : <button className={primary} disabled={busy} onClick={() => void submitTest()} type="button">{busy ? "Saving result..." : "Submit and save result"}</button>}
        </div>
        <p className="mt-3 text-xs text-[#756B80]">You may submit with unanswered questions. Marks and answer explanations are calculated by the backend.</p>
      </section>}

      {result && <section className="learnos-card p-5 sm:p-6" aria-labelledby="result-heading">
        <p className="text-xs font-semibold text-[#642BD8]">Saved result - {result.topicTitle}</p>
        <h2 className="mt-2 text-xl font-semibold" id="result-heading">{result.correct}/{result.total} marks ({result.percentage}%)</h2>
        <p className="mt-2 text-sm text-[#756B80]">{result.correct} correct - {result.incorrect} incorrect - {result.unanswered} unanswered</p>
        <ol className="mt-5 space-y-4">{result.questions.map((question, questionIndex) => <li className="rounded-md bg-[#F2ECFF] p-4 text-sm" key={question.questionId}>
          <h3 className="font-semibold">{questionIndex + 1}. {question.prompt}</h3>
          {question.selectedIndex === question.correctIndex
            ? <p className="mt-2 font-medium text-green-700">✓ Your answer: {question.options[question.selectedIndex]}</p>
            : <p className="mt-2 font-medium text-red-600">✗ Your answer: {question.selectedIndex === null ? "Not answered" : question.options[question.selectedIndex]}</p>}
          <p className="mt-1 font-medium text-green-700">✓ Correct answer: {question.options[question.correctIndex]}</p>
          <p className="mt-2 leading-6 text-[#756B80]">{question.explanation}</p>
        </li>)}</ol>
      </section>}

      <section className="learnos-card p-5 sm:p-6" aria-labelledby="history-heading">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold" id="history-heading">Mock test results</h2><button className={secondary} disabled={historyLoading} onClick={() => void refreshHistory()} type="button">Refresh results</button></div>
        <p className="mt-2 text-sm text-[#756B80]">Topic-wise marks from the recent saved attempts listed below. Tests provide learning evidence; they do not automatically mark a lesson as mastered.</p>
        {historyLoading && <p className="mt-3 text-sm text-[#756B80]" role="status">Loading saved results...</p>}
        {historyError && <p className="mt-3 rounded-md bg-[#F2ECFF] p-3 text-sm" role="status">{historyError}</p>}
        {!historyLoading && !historyError && !attempts.length && <p className="mt-4 text-sm text-[#756B80]">Your completed mock tests and topic-wise marks will appear here.</p>}
        {!!topicMarks.length && <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Topic-wise marks for loaded saved attempts</caption><thead><tr className="border-b border-[#EEE5E0]">{["Topic", "Attempts", "Total marks", "Average", "Latest", "Best"].map((title) => <th className="p-2 font-semibold" key={title} scope="col">{title}</th>)}</tr></thead><tbody>{topicMarks.map((item) => <tr className="border-b border-[#EEE5E0]" key={`${item.syllabusVersion}:${item.topicId}`}><th className="p-2 font-medium" scope="row">{item.topicTitle}<span className="block text-xs text-[#756B80]">{item.moduleTitle} - syllabus v{item.syllabusVersion}</span></th><td className="p-2">{item.attempts}</td><td className="p-2">{item.correct}/{item.total}</td><td className="p-2">{item.percentage}%</td><td className="p-2">{item.latestPercentage}%</td><td className="p-2">{item.bestPercentage}%</td></tr>)}</tbody></table></div>}
        <ul className="mt-5 space-y-3">{attempts.map((attempt) => <li className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#EEE5E0] p-3" key={attempt.attemptId}>
          <div><p className="text-sm font-semibold">{attempt.topicTitle}: {attempt.correct}/{attempt.total} ({attempt.percentage}%)</p><p className="mt-1 text-xs text-[#756B80]">{attempt.moduleTitle} - {attempt.completedAt ? new Date(attempt.completedAt).toLocaleString() : "Saved attempt"} - {attempt.incorrect} incorrect, {attempt.unanswered} unanswered</p></div>
          <button className={secondary} disabled={busy || activeQuiz} onClick={() => { setResult(attempt); setError(""); }} type="button">Review answers</button>
        </li>)}</ul>
      </section>
    </div>
  </main>;
}
