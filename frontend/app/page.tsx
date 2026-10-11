import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-[#f6f5ef] text-[#1b302b]">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-6 lg:px-10">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          LearnOS <span className="text-[#d16445]">AI</span>
        </Link>
        <nav className="flex items-center gap-3">
          <Link href="/signin" className="px-4 py-2 text-sm font-medium hover:text-[#d16445]">
            Sign in
          </Link>
          <Link href="/signup" className="rounded-md bg-[#1b302b] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#28473f]">
            Sign up
          </Link>
        </nav>
      </header>

      <main className="mx-auto grid min-h-[calc(100vh-88px)] max-w-7xl items-center gap-12 px-6 pb-16 pt-8 lg:grid-cols-[1.05fr_0.95fr] lg:px-10 lg:pb-24">
        <section className="max-w-2xl">
          <p className="mb-6 text-xs font-bold uppercase tracking-[0.18em] text-[#d16445]">
            A better way to learn
          </p>
          <h1 className="max-w-xl text-5xl font-semibold leading-[1.06] tracking-tight sm:text-6xl">
            Your learning, <span className="font-serif italic text-[#d16445]">in motion.</span>
          </h1>
          <p className="mt-7 max-w-lg text-lg leading-8 text-[#586761]">
            LearnOS AI turns your goals into a focused learning path, with an AI tutor and progress that grows with you.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href="/signup" className="rounded-md bg-[#d16445] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#b84f34]">
              Start learning
            </Link>
            <Link href="/signin" className="rounded-md border border-[#c9cec4] px-6 py-3 text-sm font-semibold transition hover:border-[#1b302b]">
              Sign in
            </Link>
          </div>
        </section>

        <aside className="relative overflow-hidden rounded-lg bg-[#1b302b] p-8 text-[#f6f5ef] sm:p-10">
          <div className="absolute -right-12 -top-16 h-56 w-56 rounded-full border border-white/10" />
          <div className="absolute -right-2 -top-6 h-36 w-36 rounded-full border border-white/10" />
          <div className="relative">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#e7a48e]">Your next chapter</p>
            <p className="mt-10 max-w-sm font-serif text-3xl leading-tight">
              One clear goal. A path that adapts as you learn.
            </p>
            <div className="mt-12 border-t border-white/15 pt-5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/65">Built around your goals</span>
                <span className="text-[#e7a48e]">01 / 03</span>
              </div>
              <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/15">
                <div className="h-full w-1/3 bg-[#e7a48e]" />
              </div>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
