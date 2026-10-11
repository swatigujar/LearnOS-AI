"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { signOut } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import {
  getLearningGoals,
  type LearningGoal,
} from "@/lib/learning-data";

const sections = ["Dashboard", "AI Tutor", "Practice", "Notes", "Progress / Mastery"] as const;
type Section = (typeof sections)[number];

export default function DashboardPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [section, setSection] = useState<Section>("Dashboard");
  const [profileName, setProfileName] = useState("");
  const [goals, setGoals] = useState<LearningGoal[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!authLoading && !user) router.replace("/signin");
  }, [authLoading, router, user]);

  useEffect(() => {
    if (!user) return;
    const currentUser = user;
    let active = true;

    async function loadLearningData() {
      setDataLoading(true);
      try {
        const profileRef = doc(db, "users", currentUser.uid);
        const [profileSnapshot, savedGoals] = await Promise.all([
          getDoc(profileRef),
          getLearningGoals(currentUser.uid),
        ]);

        if (!active) return;
        const profile = profileSnapshot.data();
        setProfileName(profile?.displayName || currentUser.displayName || "Learner");
        setGoals(savedGoals);
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load your learning data.");
        }
      } finally {
        if (active) setDataLoading(false);
      }
    }

    void loadLearningData();
    return () => {
      active = false;
    };
  }, [user]);

  async function handleSignOut() {
    await signOut(auth);
    router.replace("/");
  }

  if (authLoading || !user || dataLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f6f5ef] text-sm text-[#68736d]">
        Loading your learning space...
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-[#f6f5ef] text-[#1b302b]">
      <header className="flex h-[72px] items-center justify-between border-b border-[#e0e2d9] bg-white px-5 sm:px-8">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          LearnOS <span className="text-[#d16445]">AI</span>
        </Link>
        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-[#68736d] sm:block">{user.email}</span>
          <button onClick={handleSignOut} className="rounded-md border border-[#d9ddd5] px-3 py-2 text-sm font-semibold transition hover:border-[#1b302b]" type="button">
            Log out
          </button>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-8 px-5 py-7 sm:px-8 lg:grid-cols-[230px_minmax(0,1fr)] lg:py-10">
        <aside>
          <div className="mb-5 px-3">
            <p className="text-xs font-bold uppercase tracking-[0.15em] text-[#89938c]">Workspace</p>
            <p className="mt-2 truncate text-sm font-semibold">{profileName}</p>
          </div>
          <nav aria-label="Dashboard sections" className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible">
            {sections.map((item) => (
              <button
                aria-current={section === item ? "page" : undefined}
                className={`shrink-0 rounded-md px-3 py-2.5 text-left text-sm transition ${section === item ? "bg-[#1b302b] font-semibold text-white" : "text-[#586761] hover:bg-white"}`}
                key={item}
                onClick={() => setSection(item)}
                type="button"
              >
                {item}
              </button>
            ))}
          </nav>
        </aside>

        <main className="min-w-0">
          <div className="mb-8">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#d16445]">Student dashboard</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{section === "Dashboard" ? `Welcome, ${profileName.split(" ")[0]}` : section}</h1>
            <p className="mt-2 text-sm text-[#68736d]">A focused place to build your next skill.</p>
          </div>

          {error && <p className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{error}</p>}

          {section === "Dashboard" ? (
            <div>
              <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Your learning goals</h2>
                  <p className="mt-1 text-sm text-[#68736d]">{goals.length} {goals.length === 1 ? "course" : "courses"}</p>
                </div>
                <Link className="rounded-md bg-[#d16445] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#b84f34]" href="/dashboard/new">
                  + New learning goal
                </Link>
              </div>
              {goals.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {goals.map((goal) => (
                    <Link
                      className="group rounded-lg border border-[#e0e2d9] bg-white p-5 transition hover:-translate-y-0.5 hover:border-[#b8c1b8] hover:shadow-sm"
                      href={`/dashboard/courses/${goal.id}`}
                      key={goal.id}
                    >
                      <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#d16445]">Learning course</p>
                      <h3 className="mt-3 text-xl font-semibold group-hover:text-[#b84f34]">{goal.courseName}</h3>
                      <p className="mt-2 line-clamp-3 text-sm leading-6 text-[#68736d]">{goal.goalText}</p>
                      <div className="mt-5 flex items-center justify-between border-t border-[#edf0e9] pt-4 text-xs text-[#68736d]">
                        <span>{goal.skillLevel ? `${goal.skillLevel} level` : "Goal saved"}</span>
                        <span className="font-semibold text-[#1b302b]">Open course →</span>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <section className="rounded-lg border border-[#e0e2d9] bg-white p-7">
                  <h3 className="text-lg font-semibold">Your first course starts with a goal</h3>
                  <p className="mt-2 text-sm leading-6 text-[#68736d]">Add a subject and a little context to set up your learning space.</p>
                </section>
              )}
            </div>
          ) : (
            <section className="rounded-lg border border-[#e0e2d9] bg-white p-7 sm:p-9">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#d16445]">Coming next</p>
              <h2 className="mt-3 text-xl font-semibold">{section}</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-[#68736d]">This space is ready for your learning journey. Your goals and progress are already saved in your workspace.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}