"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { InterviewPractice } from "@/components/practice-mode-pages";
import { ScenarioPractice } from "@/components/scenario-practice";
import { useAuth } from "@/lib/auth-context";
import { fetchUserProgress, type CourseProgress } from "@/lib/progress";

const modes = [
  { name: "Scenario-Based Practice", description: "Investigate realistic situations using your saved course topics." },
  { name: "Interview Practice", description: "Prepare by skill and target role with reviewed or generated questions." },
  { name: "Mock Test", description: "Take a separate course assessment with its existing exam flow." },
] as const;
type Mode = (typeof modes)[number];

export function PracticeCenter() {
  const [mode, setMode] = useState<Mode>(modes[0]);
  return <section className="space-y-5">
    <div>
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#c35d42]">Practice Center</p>
      <h2 className="mt-2 text-xl font-semibold text-[#19352d]">Choose how to practice</h2>
      <p className="mt-1 text-sm leading-6 text-[#68736d]">Choose a practical scenario, interview preparation, or a separate course assessment.</p>
    </div>
    <nav aria-label="Practice modes" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {modes.map((item) => <button aria-pressed={mode.name === item.name} className={`min-w-0 rounded-xl border p-4 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59] ${mode.name === item.name ? "border-[#176b59] bg-[#f1f7f3] shadow-sm" : "border-[#dce3db] bg-white hover:border-[#a9b9ae] hover:bg-[#fafbf9]"}`} key={item.name} onClick={() => setMode(item)} type="button"><span className="block font-semibold text-[#19352d]">{item.name}</span><span className="mt-1 block text-sm leading-5 text-[#68736d]">{item.description}</span></button>)}
    </nav>
    {mode.name === "Scenario-Based Practice" ? <ScenarioPractice /> : mode.name === "Interview Practice" ? <InterviewPractice /> : <MockTestEntry />}
    <p className="text-xs text-[#68736d]">Practice sessions do not change lesson completion or course mastery. Mock Test remains a separate assessment.</p>
  </section>;
}

function MockTestEntry() {
  const { user } = useAuth();
  const [courses, setCourses] = useState<CourseProgress[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void Promise.resolve().then(async () => {
      setLoading(true);
      setError("");
      return fetchUserProgress(await user.getIdToken());
    }).then((summary) => {
      if (!active) return;
      const readyCourses = summary.courses.filter((course) => course.syllabusStatus === "ready");
      setCourses(readyCourses);
      setSelectedId((current) => readyCourses.some((course) => course.courseId === current) ? current : readyCourses[0]?.courseId ?? "");
    }).catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "Active courses could not be loaded.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reloadKey, user]);

  return <section className="rounded-xl border border-[#dce3db] bg-white p-5 shadow-sm sm:p-6">
    <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#c35d42]">Separate assessment</p>
    <h3 className="mt-2 text-lg font-semibold text-[#19352d]">Mock Test</h3>
    <p className="mt-1 text-sm leading-6 text-[#68736d]">Choose an active course to open its existing course-specific Mock Test. This assessment has its own question selection, scoring, and results.</p>
    {!user ? <p className="mt-4 text-sm text-[#68736d]">Sign in to choose an active course.</p> : loading ? <p className="mt-4 text-sm text-[#68736d]" role="status">Loading active courses…</p> : error ? <div className="mt-4" role="alert"><p className="text-sm text-red-800">{error}</p><button className="mt-2 text-sm font-semibold text-[#176b59] underline" onClick={() => setReloadKey((key) => key + 1)} type="button">Retry</button></div> : courses.length === 0 ? <p className="mt-4 rounded-md bg-[#f6f8f5] p-4 text-sm leading-6 text-[#68736d]">No active courses with a saved syllabus are available for a Mock Test yet.</p> : <div className="mt-4 flex flex-wrap items-end gap-3"><label className="min-w-0 flex-1 text-sm font-medium">Course<select className="mt-2 block min-h-11 w-full rounded-md border border-[#d9ddd5] bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59]" onChange={(event) => setSelectedId(event.target.value)} value={selectedId}>{courses.map((course) => <option key={course.courseId} value={course.courseId}>{course.title}</option>)}</select></label>{selectedId && <Link className="inline-flex min-h-11 items-center rounded-md bg-[#176b59] px-4 py-2 text-sm font-semibold text-white hover:bg-[#125644] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59]" href={`/dashboard/courses/${encodeURIComponent(selectedId)}/mock-test`}>Open Mock Test</Link>}</div>}
  </section>;
}
