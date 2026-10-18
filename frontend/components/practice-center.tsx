"use client";

import Link from "next/link";
import { ClipboardCheck, Compass, MessagesSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { InterviewPractice } from "@/components/practice-mode-pages";
import { ScenarioPractice } from "@/components/scenario-practice";
import { useAuth } from "@/lib/auth-context";
import { fetchUserProgress, type CourseProgress } from "@/lib/progress";
import { Select } from "@/components/ui/select";

const modes = [
  { name: "Scenario-Based Practice", description: "Investigate realistic situations using your saved course topics.", Icon: Compass },
  { name: "Interview Practice", description: "Prepare by skill and target role with reviewed or generated questions.", Icon: MessagesSquare },
  { name: "Mock Test", description: "Take a separate course assessment with its existing exam flow.", Icon: ClipboardCheck },
] as const;
type Mode = (typeof modes)[number];

export function PracticeCenter() {
  const [mode, setMode] = useState<Mode>(modes[0]);
  return <section className="min-w-0 space-y-6">
    <div>
      <p className="inline-flex rounded-full border border-[#E7DDF8] bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[#642BD8]">Practice Center</p>
      <h2 className="mt-3 text-2xl font-bold tracking-tight text-[#29213D]">Choose how to practice</h2>
      <p className="mt-1 text-sm leading-6 text-[#756B80]">Choose a practical scenario, interview preparation, or a separate course assessment.</p>
    </div>
    <nav aria-label="Practice modes" className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {modes.map((item) => <button aria-pressed={mode.name === item.name} className={`group flex min-w-0 items-start gap-3 rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8] ${mode.name === item.name ? "border-[#C5B1F1] bg-[linear-gradient(135deg,#F2ECFF,#FFFDFB)] shadow-[0_16px_36px_-28px_rgba(74,40,95,0.28)]" : "border-[#EEE5E0] bg-white hover:border-[#D9C9EB] hover:bg-[#FFFCF9]"}`} key={item.name} onClick={() => setMode(item)} type="button"><span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${mode.name === item.name ? "bg-[#642BD8] text-white" : "bg-[#F2ECFF] text-[#642BD8]"}`}><item.Icon aria-hidden="true" size={18} /></span><span className="min-w-0"><span className="block font-semibold text-[#4A285F]">{item.name}</span><span className="mt-1 block text-sm leading-5 text-[#756B80]">{item.description}</span></span></button>)}
    </nav>
    {mode.name === "Scenario-Based Practice" ? <ScenarioPractice /> : mode.name === "Interview Practice" ? <InterviewPractice /> : <MockTestEntry />}
    <p className="text-xs text-[#756B80]">Practice sessions do not change lesson completion or course mastery. Mock Test remains a separate assessment.</p>
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

  return <section className="learnos-card p-5 shadow-[0_14px_40px_-32px_rgba(74,40,95,0.22)] sm:p-6">
    <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#642BD8]">Separate assessment</p>
    <h3 className="mt-2 text-lg font-semibold text-[#4A285F]">Mock Test</h3>
    <p className="mt-1 text-sm leading-6 text-[#756B80]">Choose an active course to open its existing course-specific Mock Test. This assessment has its own question selection, scoring, and results.</p>
    {!user ? <p className="mt-4 text-sm text-[#756B80]">Sign in to choose an active course.</p> : loading ? <p className="mt-4 text-sm text-[#756B80]" role="status">Loading active courses…</p> : error ? <div className="mt-4" role="alert"><p className="text-sm text-red-800">{error}</p><button className="mt-2 text-sm font-semibold text-[#642BD8] underline" onClick={() => setReloadKey((key) => key + 1)} type="button">Retry</button></div> : courses.length === 0 ? <p className="mt-4 rounded-md bg-[#F2ECFF] p-4 text-sm leading-6 text-[#756B80]">No active courses with a saved syllabus are available for a Mock Test yet.</p> : <div className="mt-4 flex min-w-0 flex-wrap items-end gap-3"><label className="min-w-0 flex-1 text-sm font-medium">Course<Select className="mt-2" label="Course" onValueChange={setSelectedId} options={courses.map((course) => ({ value: course.courseId, label: course.title }))} value={selectedId} /></label>{selectedId && <Link className="inline-flex min-h-11 shrink-0 items-center rounded-md bg-[#642BD8] px-4 py-2 text-sm font-semibold text-white hover:bg-[#5322B5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]" href={`/dashboard/courses/${encodeURIComponent(selectedId)}/mock-test`}>Open Mock Test</Link>}</div>}
  </section>;
}
