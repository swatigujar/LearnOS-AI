"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Folder } from "lucide-react";
import { collection, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import { mapGoal, type LearningGoal } from "@/lib/learning-data";
import { CourseNotesFolder } from "@/components/course-notes-folder";

export function NotesLibrary() {
  const { user } = useAuth();
  const [courses, setCourses] = useState<LearningGoal[]>([]);
  const [coursesOwnerId, setCoursesOwnerId] = useState<string | null>(null);
  const [openCourseId, setOpenCourseId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<{ userId: string; message: string } | null>(null);
  const userId = user?.uid;

  useEffect(() => {
    if (!userId) return;
    return onSnapshot(
      collection(db, "users", userId, "learningGoals"),
      (snapshot) => {
        setCourses(snapshot.docs.map(mapGoal));
        setCoursesOwnerId(userId);
        setLoadError(null);
      },
      () => {
        setCoursesOwnerId(userId);
        setLoadError({ userId, message: "Unable to load your Notes folders." });
      },
    );
  }, [userId]);

  const openCourse = coursesOwnerId === userId
    ? courses.find((course) => course.id === openCourseId)
    : undefined;

  if (!userId || (coursesOwnerId !== userId && loadError?.userId !== userId)) {
    return <p className="rounded-lg border border-[#EEE5E0] bg-white p-6 text-sm text-[#756B80]" role="status">Loading your Notes folders...</p>;
  }

  if (loadError?.userId === userId) {
    return <p className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-800" role="alert">{loadError.message}</p>;
  }

  if (openCourse) {
    return (
      <section aria-labelledby="notes-folder-title" className="learnos-card p-6 shadow-[0_18px_50px_-42px_rgba(74,40,95,0.24)] sm:p-8">
        <button
          className="inline-flex items-center gap-2 text-sm font-semibold text-[#756B80] hover:text-[#29213D] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]"
          onClick={() => setOpenCourseId(null)}
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={16} /> All Notes folders
        </button>
        <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#642BD8]">Notes folder</p>
            <h2 className="mt-2 break-words text-2xl font-semibold" id="notes-folder-title">{openCourse.courseName}</h2>
          </div>
          <Link
            className="rounded-md border border-[#EEE5E0] px-3 py-2 text-sm font-semibold text-[#642BD8] transition hover:border-[#642BD8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]"
            href={`/dashboard/courses/${openCourse.id}`}
          >
            Open course
          </Link>
        </div>
        {user && <CourseNotesFolder courseId={openCourse.id} user={user} />}
      </section>
    );
  }

  if (courses.length === 0) {
    return (
      <section className="rounded-2xl border border-[#EEE5E0] bg-[linear-gradient(135deg,#fff,#FCF9FF)] p-7 shadow-[0_18px_50px_-42px_rgba(36,34,70,0.45)]">
        <h2 className="text-lg font-semibold">No course folders yet</h2>
        <p className="mt-2 text-sm leading-6 text-[#756B80]">Create a learning course and its Notes folder will appear here.</p>
        <Link className="mt-4 inline-flex rounded-md bg-[#642BD8] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#5322B5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]" href="/dashboard/new">
          Create a course
        </Link>
      </section>
    );
  }

  return (
    <section aria-label="Notes folders">
      <p className="mb-5 text-sm text-[#756B80]">Each folder is linked to its saved course.</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {courses.map((course) => (
          <button
            className="group flex min-h-32 items-center gap-4 learnos-card p-5 text-left shadow-[0_12px_32px_-28px_rgba(74,40,95,0.22)] transition hover:-translate-y-1 hover:border-[#D9C9EB] hover:shadow-[0_22px_42px_-30px_rgba(81,68,198,0.35)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]"
            key={course.id}
            onClick={() => setOpenCourseId(course.id)}
            type="button"
          >
            <Folder aria-hidden="true" className="shrink-0 text-[#642BD8]" size={30} />
            <span className="min-w-0">
              <span className="block break-words font-semibold text-[#29213D] group-hover:text-[#5322B5]">{course.courseName}</span>
              <span className="mt-1 block text-sm text-[#756B80]">Open folder</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
