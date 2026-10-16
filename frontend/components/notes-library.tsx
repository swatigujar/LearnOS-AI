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
    return <p className="rounded-lg border border-[#e0e2d9] bg-white p-6 text-sm text-[#68736d]" role="status">Loading your Notes folders...</p>;
  }

  if (loadError?.userId === userId) {
    return <p className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-800" role="alert">{loadError.message}</p>;
  }

  if (openCourse) {
    return (
      <section aria-labelledby="notes-folder-title" className="rounded-lg border border-[#e0e2d9] bg-white p-6 sm:p-8">
        <button
          className="inline-flex items-center gap-2 text-sm font-semibold text-[#586761] hover:text-[#1b302b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]"
          onClick={() => setOpenCourseId(null)}
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={16} /> All Notes folders
        </button>
        <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#d16445]">Notes folder</p>
            <h2 className="mt-2 break-words text-2xl font-semibold" id="notes-folder-title">{openCourse.courseName}</h2>
          </div>
          <Link
            className="rounded-md border border-[#d9ddd5] px-3 py-2 text-sm font-semibold text-[#1b6657] transition hover:border-[#1b6657] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]"
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
      <section className="rounded-lg border border-[#e0e2d9] bg-white p-7">
        <h2 className="text-lg font-semibold">No course folders yet</h2>
        <p className="mt-2 text-sm leading-6 text-[#68736d]">Create a learning course and its Notes folder will appear here.</p>
        <Link className="mt-4 inline-flex rounded-md bg-[#d16445] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#b84f34] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d16445]" href="/dashboard/new">
          Create a course
        </Link>
      </section>
    );
  }

  return (
    <section aria-label="Notes folders">
      <p className="mb-5 text-sm text-[#68736d]">Each folder is linked to its saved course.</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {courses.map((course) => (
          <button
            className="group flex min-h-28 items-center gap-4 rounded-lg border border-[#e0e2d9] bg-white p-5 text-left transition hover:-translate-y-0.5 hover:border-[#b8c1b8] hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]"
            key={course.id}
            onClick={() => setOpenCourseId(course.id)}
            type="button"
          >
            <Folder aria-hidden="true" className="shrink-0 text-[#d16445]" size={30} />
            <span className="min-w-0">
              <span className="block break-words font-semibold text-[#1b302b] group-hover:text-[#b84f34]">{course.courseName}</span>
              <span className="mt-1 block text-sm text-[#68736d]">Open folder</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
