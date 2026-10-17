"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import type { User } from "firebase/auth";
import { CheckCircle2, Download, FileText, RefreshCw } from "lucide-react";
import { collection, doc, getDoc, onSnapshot, type Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

type Topic = { topic_id: string; title: string; description: string };
type Module = { module_id: string; title: string; topics: Topic[] };
type NoteRecord = {
  status: "queued" | "generating" | "completed" | "failed" | "deleting";
  title?: string;
  lastError?: string;
  syllabusVersion?: number;
  generationStartedAt?: Timestamp;
  updatedAt?: Timestamp;
  createdAt?: Timestamp;
  sources?: { title: string; url: string; description?: string }[];
};

function GenerationTimer({ note }: { note: NoteRecord }) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(mountedAt);
  const startedAt = (note.status === "generating"
    ? note.generationStartedAt ?? note.updatedAt ?? note.createdAt
    : note.createdAt)?.toMillis() ?? mountedAt;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return <p aria-live="off" className="mt-1 text-xs text-[#68736d]">Elapsed: {Math.max(0, Math.floor((now - startedAt) / 1000))} seconds</p>;
}

function NoteImage({ user, courseId, topicId, title }: { user: User; courseId: string; topicId: string; title: string }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    async function load() {
      try {
        const token = await user.getIdToken();
        const response = await fetch(`/api/notes/${encodeURIComponent(courseId)}/${encodeURIComponent(topicId)}/image`, {
          headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
        });
        if (!response.ok) throw new Error("Image unavailable");
        const createdUrl = URL.createObjectURL(await response.blob());
        if (!active) { URL.revokeObjectURL(createdUrl); return; }
        objectUrl = createdUrl;
        setUrl(objectUrl);
      } catch {
        if (active) setFailed(true);
      }
    }
    void load();
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [courseId, topicId, user]);

  if (failed) return <p className="mt-3 text-sm text-[#68736d]" role="status">The handwritten image is temporarily unavailable.</p>;
  if (!url) return <p className="mt-3 text-sm text-[#68736d]" role="status">Loading handwritten page…</p>;
  const filename = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim() || "Lesson notes"}.jpg`;
  return <div><a className="mt-3 inline-flex items-center gap-2 rounded-md bg-[#1b6657] px-3 py-2 text-sm font-semibold text-white" download={filename} href={url}><Download aria-hidden="true" size={16} />Download notes</a><Image alt={`Handwritten notes for ${title}`} className="mt-4 h-auto max-h-[760px] w-full rounded-md border border-[#e0e2d9] object-contain" height={2048} src={url} unoptimized width={1536} /></div>;
}

export function CourseNotesFolder({ user, courseId }: { user: User; courseId: string }) {
  const [modules, setModules] = useState<Module[]>([]);
  const [completed, setCompleted] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, NoteRecord>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    let stopNotes = () => {};
    async function load() {
      setLoading(true);
      setError("");
      try {
        const courseRef = doc(db, "users", user.uid, "courses", courseId);
        const courseSnapshot = await getDoc(courseRef);
        const course = courseSnapshot.data();
        const version = course?.syllabusVersion;
        if (!courseSnapshot.exists() || course?.syllabusStatus !== "ready" || typeof version !== "number") {
          if (active) setModules([]);
          return;
        }
        const [syllabusSnapshot, tutorSnapshot] = await Promise.all([
          getDoc(doc(db, "users", user.uid, "courses", courseId, "syllabus", `v${version}`)),
          getDoc(doc(db, "users", user.uid, "courses", courseId, "tutor", "state")),
        ]);
        if (!syllabusSnapshot.exists()) {
          if (active) setModules([]);
          return;
        }
        const savedSyllabus = syllabusSnapshot.data();
        const savedModules = Array.isArray(savedSyllabus.modules) ? savedSyllabus.modules as Module[] : [];
        const topicStatus = tutorSnapshot.data()?.topic_status as Record<string, string> | undefined;
        if (!active) return;
        setModules(savedModules);
        setCompleted(Object.fromEntries(Object.entries(topicStatus ?? {}).map(([id, status]) => [id, status === "completed"])));
        stopNotes = onSnapshot(
          collection(db, "users", user.uid, "courses", courseId, "notes"),
          (snapshot) => {
            const records: Record<string, NoteRecord> = {};
            snapshot.docs.forEach((item) => {
              const value = item.data() as NoteRecord & { topicId?: string };
              if (value.syllabusVersion !== undefined && value.syllabusVersion !== version) return;
              const topicId = value.topicId ?? item.id.replace(/-v\d+$/, "");
              records[topicId] = value;
            });
            setNotes(records);
          },
          () => setError("Unable to load notes for this course."),
        );
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : "Unable to load this course folder.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; stopNotes(); };
  }, [courseId, user]);

  async function retry(topicId: string) {
    setRetrying((current) => ({ ...current, [topicId]: true }));
    setRetryErrors((current) => ({ ...current, [topicId]: "" }));
    try {
      const token = await user.getIdToken();
      const response = await fetch(`/api/notes/${encodeURIComponent(courseId)}/${encodeURIComponent(topicId)}/retry`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail ?? "Unable to request handwritten notes.");
    } catch (failure) {
      setRetryErrors((current) => ({ ...current, [topicId]: failure instanceof Error ? failure.message : "Unable to request handwritten notes." }));
    } finally {
      setRetrying((current) => ({ ...current, [topicId]: false }));
    }
  }

  if (loading) return <p className="mt-7 rounded-lg border border-[#e0e2d9] bg-[#fafaf7] p-6 text-sm text-[#68736d]" role="status">Loading topics and notes…</p>;
  if (error) return <p className="mt-7 rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-800" role="alert">{error}</p>;

  return (
    <div className="mt-7 space-y-7">
      {modules.map((module) => (
        <section aria-labelledby={`notes-${module.module_id}`} className="space-y-3" key={module.module_id}>
          <h3 className="border-b border-[#e0e2d9] pb-2 text-lg font-semibold text-[#1b302b]" id={`notes-${module.module_id}`}>{module.title}</h3>
          {module.topics.map((topic) => {
            const note = notes[topic.topic_id];
            const isCompleted = completed[topic.topic_id] === true;
            return (
              <article className="rounded-lg border border-[#e0e2d9] bg-white p-4 sm:p-5" key={topic.topic_id}>
                <div className="flex items-start gap-3">
                  {isCompleted ? <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0 text-green-700" size={18} /> : <FileText aria-hidden="true" className="mt-0.5 shrink-0 text-[#89938c]" size={18} />}
                  <div className="min-w-0 flex-1">
                    <h4 className="break-words font-semibold text-[#1b302b]">{topic.title}</h4>
                    {note?.status === "completed" ? (
                      <>
                        <NoteImage user={user} courseId={courseId} topicId={topic.topic_id} title={topic.title} />
                        {!!note.sources?.length && <div className="mt-4 text-xs text-[#68736d]"><p className="font-semibold">Sources</p><ul className="mt-1 list-disc space-y-1 pl-5">{note.sources.map((source) => <li key={source.url}><a className="underline decoration-[#aab3aa] underline-offset-2 hover:text-[#1b6657]" href={source.url} rel="noreferrer" target="_blank">{source.title}</a></li>)}</ul></div>}
                      </>
                    ) : note?.status === "queued" || note?.status === "generating" ? (
                      <div className="mt-2"><p className="text-sm text-[#68736d]" role="status">{note.status === "queued" ? "Handwritten notes are queued…" : "Generating handwritten notes…"}</p><GenerationTimer key={note.status} note={note} /><button className="mt-2 inline-flex items-center gap-2 rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold text-[#586761] disabled:opacity-50" disabled={!!retrying[topic.topic_id]} onClick={() => void retry(topic.topic_id)} type="button"><RefreshCw aria-hidden="true" size={14} />{retrying[topic.topic_id] ? "Checking…" : "Check generation"}</button></div>
                    ) : note?.status === "deleting" ? (
                      <p className="mt-2 text-sm text-[#68736d]" role="status">Removing notes with this course…</p>
                    ) : note?.status === "failed" ? (
                      <div className="mt-2"><p className="text-sm text-[#68736d]">{note.lastError ?? "Notes could not be generated."}</p><button className="mt-3 inline-flex items-center gap-2 rounded-md border border-[#1b6657] px-3 py-2 text-sm font-semibold text-[#1b6657] disabled:opacity-50" disabled={!!retrying[topic.topic_id]} onClick={() => void retry(topic.topic_id)} type="button"><RefreshCw aria-hidden="true" size={15} />{retrying[topic.topic_id] ? "Retrying…" : "Retry notes"}</button></div>
                    ) : isCompleted ? (
                      <div className="mt-2"><p className="text-sm text-[#68736d]">No notes generated yet.</p><button className="mt-3 inline-flex items-center gap-2 rounded-md bg-[#1b6657] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={!!retrying[topic.topic_id]} onClick={() => void retry(topic.topic_id)} type="button"><RefreshCw aria-hidden="true" size={15} />{retrying[topic.topic_id] ? "Starting…" : "Generate notes"}</button></div>
                    ) : <p className="mt-2 text-sm text-[#68736d]">Notes will be generated when you complete this subtopic.</p>}
                    {retryErrors[topic.topic_id] && <p className="mt-2 text-sm text-red-800" role="alert">{retryErrors[topic.topic_id]}</p>}
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      ))}
      {modules.length === 0 && <p className="rounded-lg border border-dashed border-[#d9ddd5] p-6 text-sm text-[#68736d]">No notes generated yet. Course topics and handwritten pages will appear here after the syllabus is ready and you complete a subtopic.</p>}
    </div>
  );
}
