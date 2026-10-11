"use client";

import { useEffect, useState } from "react";
import { BookOpen, CheckCircle2, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { doc, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import { useTutor } from "@/lib/tutor";
import { AiTutor } from "@/components/ai-tutor";

type Syllabus = {
  overview: string;
  objective: string;
  duration_days: number;
  total_study_hours: number;
  prerequisites: string[];
  modules: {
    module_id: string;
    title: string;
    description: string;
    estimated_hours: number;
    topics: { topic_id: string; title: string; description: string; estimated_minutes: number }[];
  }[];
  resources: { title: string; url: string; source_type: string; description: string }[];
};

export function CourseSyllabus({ courseId }: { courseId: string }) {
  const { user } = useAuth();
  const [status, setStatus] = useState<string>("");
  const [syllabus, setSyllabus] = useState<Syllabus | null>(null);
  const [error, setError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({});
  const [expandedTopics, setExpandedTopics] = useState<Record<string, boolean>>({});
  const tutor = useTutor(courseId, status === "ready" && !!syllabus);

  useEffect(() => {
    if (!user) return;
    let stopSyllabus: (() => void) | undefined;
    const stopCourse = onSnapshot(doc(db, "users", user.uid, "courses", courseId), (snapshot) => {
      stopSyllabus?.();
      const course = snapshot.data();
      setStatus(course?.syllabusStatus ?? "");
      if (course?.syllabusStatus === "ready" && course.syllabusVersion > 0) {
        stopSyllabus = onSnapshot(doc(db, "users", user.uid, "courses", courseId, "syllabus", `v${course.syllabusVersion}`), (saved) => {
          setSyllabus(saved.exists() ? saved.data() as Syllabus : null);
          setError(saved.exists() ? "" : "The saved syllabus could not be found.");
          setLoading(false);
        }, (readError) => {
          setError(readError.message);
          setLoading(false);
        });
      } else {
        setSyllabus(null);
        setLoading(false);
      }
    }, (readError) => {
      setError(readError.message);
      setLoading(false);
    });
    return () => {
      stopCourse();
      stopSyllabus?.();
    };
  }, [courseId, user]);

  async function generate() {
    if (!user) return;
    setRequesting(true);
    setError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/syllabus/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ courseId }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(typeof result.detail === "string" ? result.detail : "Syllabus generation failed. Please retry.");
      }
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : "Syllabus generation failed. Please retry.");
    } finally {
      setRequesting(false);
    }
  }

  const generating = requesting || status === "generating";
  const lessons = status === "ready" ? syllabus?.modules.flatMap((module) =>
    module.topics.map((topic) => ({ ...topic, moduleTitle: module.title, moduleId: module.module_id }))
  ) ?? [] : [];
  const selectedLesson = lessons.find((topic) => topic.topic_id === tutor.state?.active_topic_id) ?? lessons[0];
  const completedTopics = lessons.filter((topic) => tutor.state?.topic_status[topic.topic_id] === "completed").length;
  const progress = lessons.length ? Math.round(completedTopics / lessons.length * 100) : 0;
  const selectedIndex = lessons.findIndex((topic) => topic.topic_id === selectedLesson?.topic_id);
  const nextLesson = lessons[selectedIndex + 1];
  const activeModule = syllabus?.modules.find((module) => module.module_id === selectedLesson?.moduleId);
  const moduleReady = !!activeModule && tutor.state?.module_status[activeModule.module_id] !== "completed"
    && activeModule.topics.every((topic) => tutor.state?.topic_status[topic.topic_id] === "completed");

  function canSelect(topicId: string) {
    return lessons.some((topic) => topic.topic_id === topicId);
  }

  async function selectTopic(topicId: string) {
    if (await tutor.perform("select", topicId)) setExpandedTopics((current) => ({ ...current, [topicId]: true }));
  }

  return (
    <div className="mt-6 grid min-w-0 border-y border-[#e0e2d9] bg-white lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
    <section className="min-w-0 px-4 py-6 sm:px-6 lg:border-r lg:border-[#e0e2d9]" aria-labelledby="syllabus-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold" id="syllabus-heading"><BookOpen aria-hidden="true" size={18} />Learning path</h2>
        {!loading && status !== "ready" && (
          <button className="rounded-md bg-[#1b302b] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60" disabled={generating} onClick={generate} type="button">
            {generating ? "Generating syllabus..." : status === "failed" ? "Retry generation" : "Generate syllabus"}
          </button>
        )}
      </div>
      {loading && <p className="mt-3 text-sm text-[#68736d]">Loading syllabus...</p>}
      {generating && <p className="mt-3 text-sm text-[#68736d]" role="status">Generating syllabus...</p>}
      {status === "failed" && !generating && <p className="mt-3 text-sm text-red-800" role="alert">Syllabus generation failed. Please retry.</p>}
      {error && <p className="mt-3 break-words text-sm text-red-800" role="alert">{error}</p>}
      {status === "ready" && syllabus && (
        <div className="mt-5 space-y-5 break-words text-sm leading-6">
          <div>
            <h3 className="whitespace-pre-wrap text-lg font-semibold">{syllabus.overview}</h3>
            <p className="mt-2 text-[#586761]">{syllabus.objective}</p>
            <p className="mt-2 text-[#68736d]">{syllabus.duration_days} days · {syllabus.total_study_hours} study hours</p>
          </div>
          <div className="border-y border-[#e0e2d9] py-3">
            <div className="flex flex-wrap justify-between gap-2 text-xs"><span className="font-semibold">Progress</span><span className="text-[#68736d]">{tutor.loading ? "Loading..." : `${completedTopics}/${lessons.length} topics confirmed`}</span></div>
            <progress aria-label="Confirmed topic progress" className="mt-2 h-2 w-full accent-[#1b6657]" max={100} value={progress} />
            <p className="mt-2 text-xs text-[#68736d]">{syllabus.modules.length} modules · {progress}% confirmed</p>
          </div>
          {syllabus.prerequisites.length > 0 && <details><summary className="cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-[#1b6657]">Prerequisites</summary><ul className="mt-2 list-disc space-y-1 pl-5">{syllabus.prerequisites.map((prerequisite, index) => <li key={index}>{prerequisite}</li>)}</ul></details>}
          <ol className="divide-y divide-[#e0e2d9]">
            {syllabus.modules.map((module, index) => (
              <li className="py-3" key={module.module_id}>
                <h3>
                  <button aria-expanded={expandedModules[module.module_id] ?? index === 0} aria-controls={`module-${module.module_id}`} className="flex w-full items-start gap-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-[#1b6657]" onClick={() => {
                    const opening = !(expandedModules[module.module_id] ?? index === 0);
                    setExpandedModules((current) => ({ ...current, [module.module_id]: opening }));
                    if (opening && !tutor.loading && !tutor.busy) void selectTopic(module.topics[0].topic_id);
                  }} type="button">
                    {(expandedModules[module.module_id] ?? index === 0) ? <ChevronDown aria-hidden="true" className="mt-1 shrink-0" size={16} /> : <ChevronRight aria-hidden="true" className="mt-1 shrink-0" size={16} />}
                    <span className="min-w-0"><span className="font-semibold">{index + 1}. {module.title}</span>{tutor.state?.module_status[module.module_id] === "completed" && <CheckCircle2 aria-label="Module completed" className="ml-2 inline text-green-700" size={16} />}<span className="block text-xs text-[#68736d]">{module.estimated_hours} hours · {module.topics.length} topics</span></span>
                  </button>
                </h3>
                <div hidden={!(expandedModules[module.module_id] ?? index === 0)} id={`module-${module.module_id}`}>
                  <p className="mb-3 pl-6 text-[#586761]">{module.description}</p>
                  <ol className="space-y-2 border-l border-[#d9ddd5] pl-3">
                    {module.topics.map((topic) => (
                      <li key={topic.topic_id}>
                        <div className={`flex items-start rounded-md ${selectedLesson?.topic_id === topic.topic_id ? "bg-[#eaf4ef] text-[#1b6657]" : "hover:bg-[#f6f8f5]"}`}>
                          <button aria-pressed={selectedLesson?.topic_id === topic.topic_id} className="min-w-0 flex-1 rounded-md p-3 text-left font-medium focus-visible:outline-2 focus-visible:outline-[#1b6657] disabled:cursor-not-allowed disabled:opacity-50" disabled={tutor.loading || tutor.busy || !canSelect(topic.topic_id)} onClick={() => void selectTopic(topic.topic_id)} title={canSelect(topic.topic_id) ? "Open lesson" : "Complete and confirm the preceding lessons first"} type="button">{tutor.state?.topic_status[topic.topic_id] === "completed" && <CheckCircle2 aria-label="Topic completed" className="mr-2 inline text-green-700" size={16} />}{topic.title}</button>
                          <button aria-label={`${expandedTopics[topic.topic_id] ? "Collapse" : "Expand"} ${topic.title}`} aria-controls={`topic-${topic.topic_id}`} aria-expanded={expandedTopics[topic.topic_id] ?? false} className="m-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-[#1b6657]" onClick={() => setExpandedTopics((current) => ({ ...current, [topic.topic_id]: !current[topic.topic_id] }))} title="Show lesson details" type="button">
                            {expandedTopics[topic.topic_id] ? <ChevronDown aria-hidden="true" size={16} /> : <ChevronRight aria-hidden="true" size={16} />}
                          </button>
                        </div>
                        <div className="px-3 pb-3 pt-2" hidden={!expandedTopics[topic.topic_id]} id={`topic-${topic.topic_id}`}>
                          <p className="text-xs font-medium text-[#68736d]">{topic.estimated_minutes} minutes</p>
                          <p className="mt-2 whitespace-pre-wrap text-[#586761]">{topic.description}</p>
                          {syllabus.resources.length > 0 && <details className="mt-3"><summary className="cursor-pointer text-xs font-semibold focus-visible:outline-2 focus-visible:outline-[#1b6657]">Course resources</summary><ul className="mt-2 space-y-2">{syllabus.resources.map((resource) => <li key={resource.url}><a className="inline-flex items-start gap-1 text-xs underline underline-offset-4" href={resource.url} rel="noopener noreferrer" target="_blank">{resource.title}<ExternalLink aria-hidden="true" className="mt-1 shrink-0" size={12} /><span className="sr-only"> (opens in a new tab)</span></a><p className="text-xs text-[#68736d]">{resource.source_type}</p></li>)}</ul></details>}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              </li>
            ))}
          </ol>
          <details className="border-t border-[#e0e2d9] pt-4">
            <summary className="cursor-pointer font-semibold focus-visible:outline-2 focus-visible:outline-[#1b6657]">All course resources</summary>
            <ul className="mt-3 space-y-3">
              {syllabus.resources.map((resource) => <li key={resource.url}><a className="font-medium underline underline-offset-4" href={resource.url} rel="noopener noreferrer" target="_blank">{resource.title}</a><p className="text-xs text-[#68736d]">{resource.source_type}</p><p className="text-[#586761]">{resource.description}</p></li>)}
            </ul>
          </details>
        </div>
      )}
    </section>
    <AiTutor controller={tutor} key={selectedLesson?.topic_id ?? courseId} lesson={selectedLesson} moduleReady={moduleReady} nextTopicId={nextLesson && canSelect(nextLesson.topic_id) ? nextLesson.topic_id : undefined} />
    </div>
  );
}