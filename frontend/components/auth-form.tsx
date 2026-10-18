"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
} from "firebase/auth";
import { auth } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { ensureUserProfile } from "@/lib/user-profile";

export function AuthForm({ mode }: { mode: "signup" | "signin" }) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const isSignup = mode === "signup";

  useEffect(() => {
    if (!authLoading && user) router.replace("/dashboard");
  }, [authLoading, router, user]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const credential = isSignup
        ? await createUserWithEmailAndPassword(auth, email.trim(), password)
        : await signInWithEmailAndPassword(auth, email.trim(), password);

      if (isSignup) {
        await updateProfile(credential.user, { displayName: name.trim() });
      }
      await ensureUserProfile(credential.user, isSignup ? name : undefined);
      router.replace("/dashboard");
    } catch (authError) {
      const message = authError instanceof Error ? authError.message : "Please try again.";
      setError(message.replace("Firebase: ", ""));
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#FFF8F1] px-5 py-12 text-[#29213D]">
      <section className="w-full max-w-md">
        <Link href="/" className="inline-flex items-center gap-2.5 text-sm font-bold tracking-tight text-[#29213D]">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#642BD8] text-white">L</span>
          <span>LearnOS <span className="font-medium text-[#642BD8]">AI</span></span>
        </Link>
        <div className="learnos-card mt-8 p-7 shadow-[0_22px_65px_-48px_rgba(74,40,95,0.28)] sm:p-9">
          <p className="inline-flex rounded-full border border-[#E7DDF8] bg-[#FCF9FF] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[#642BD8]">
            {isSignup ? "Start with a goal" : "Welcome back"}
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-[-0.035em] text-[#29213D]">
            {isSignup ? "Create your account" : "Sign in to LearnOS"}
          </h1>
          <p className="mt-2 text-sm leading-6 text-[#756B80]">
            {isSignup ? "Your personal learning space is one step away." : "Pick up where your learning left off."}
          </p>

          <form className="mt-7 space-y-4" onSubmit={handleSubmit}>
            {isSignup && (
              <label className="block text-sm font-medium">
                Name
                <input
                  autoComplete="name"
                  className="mt-1.5 block w-full rounded-xl border border-[#EEE5E0] bg-white px-3.5 py-3 font-normal outline-none transition focus:border-[#642BD8] focus:ring-2 focus:ring-[#642BD8]/15"
                  onChange={(event) => setName(event.target.value)}
                  required
                  value={name}
                />
              </label>
            )}
            <label className="block text-sm font-medium">
              Email
              <input
                autoComplete="email"
                className="mt-1.5 block w-full rounded-xl border border-[#EEE5E0] bg-white px-3.5 py-3 font-normal outline-none transition focus:border-[#642BD8] focus:ring-2 focus:ring-[#642BD8]/15"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
            <label className="block text-sm font-medium">
              Password
              <input
                autoComplete={isSignup ? "new-password" : "current-password"}
                className="mt-1.5 block w-full rounded-xl border border-[#EEE5E0] bg-white px-3.5 py-3 font-normal outline-none transition focus:border-[#642BD8] focus:ring-2 focus:ring-[#642BD8]/15"
                minLength={isSignup ? 6 : undefined}
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
            <button
              className="learnos-primary-button w-full px-4 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              disabled={submitting || authLoading}
              type="submit"
            >
              {submitting ? "Please wait..." : isSignup ? "Create account" : "Sign in"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-[#756B80]">
            {isSignup ? "Already have an account?" : "New to LearnOS?"}{" "}
            <Link className="font-semibold text-[#29213D] underline underline-offset-4" href={isSignup ? "/signin" : "/signup"}>
              {isSignup ? "Sign in" : "Create an account"}
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}
