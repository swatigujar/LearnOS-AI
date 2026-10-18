import Link from "next/link";
import {
  ArrowUpRight,
  BookOpen,
  BrainCircuit,
  ChartNoAxesCombined,
  ClipboardCheck,
  Sparkles,
} from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen overflow-hidden bg-[#FFF8F1] text-[#29213D]">
      <header className="relative z-10 mx-auto flex w-full max-w-[1440px] min-w-0 items-center justify-between gap-2 px-4 py-5 sm:px-8 lg:px-12">
        <Link href="/" className="inline-flex items-center gap-2.5 text-lg font-bold tracking-tight text-[#29213D]">
          <span className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[#642BD8] text-white shadow-[0_8px_22px_-12px_rgba(81,68,198,0.75)]"><BookOpen aria-hidden="true" size={19} /></span>
          <span>LearnOS <span className="font-medium text-[#642BD8]">AI</span></span>
        </Link>
        <nav aria-label="Account" className="flex items-center gap-2 sm:gap-3">
          <Link href="/signin" className="shrink-0 rounded-xl px-2 py-2.5 text-xs font-semibold text-[#756B80] transition hover:bg-white hover:text-[#5322B5] sm:px-4 sm:text-sm">
            Sign in
          </Link>
          <Link href="/signup" className="rounded-xl bg-[#642BD8] px-3 py-2.5 text-xs font-semibold text-white shadow-[0_10px_24px_-14px_rgba(81,68,198,0.8)] transition hover:-translate-y-0.5 hover:bg-[#5322B5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8] sm:px-4 sm:text-sm">
            <span className="sm:hidden">Sign up</span><span className="hidden sm:inline">Get started</span>
          </Link>
        </nav>
      </header>

      <main className="mx-auto flex w-full min-w-0 max-w-[1440px] flex-col items-stretch justify-center gap-10 px-5 pb-12 pt-7 sm:px-8 sm:pb-16 lg:grid lg:min-h-[calc(100svh-80px)] lg:grid-cols-[0.92fr_1.08fr] lg:items-center lg:gap-14 lg:px-12 lg:py-10">
        <section className="relative z-10 w-full min-w-0 max-w-[calc(100vw_-_2.5rem)] py-4 sm:max-w-[600px] lg:py-10">
          <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#E7DDF8] bg-white/85 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[#642BD8] shadow-[0_8px_22px_-18px_rgba(81,68,198,0.5)] sm:mb-7">
            <Sparkles aria-hidden="true" size={13} /> A better way to learn
          </p>
          <h1 className="w-full max-w-full whitespace-normal break-words text-[clamp(2.25rem,9vw,3.75rem)] font-bold leading-[1.02] tracking-[-0.055em] text-[#29213D] sm:text-6xl lg:max-w-[640px] lg:text-[4.5rem]">
            Turn your next goal into a <span className="font-serif font-medium italic tracking-[-0.045em] text-[#5322B5]">learning path.</span>
          </h1>
          <p className="mt-5 max-w-[500px] text-base leading-7 text-[#756B80] sm:mt-7 sm:text-lg sm:leading-8">
            Start with what you want to achieve. LearnOS shapes it into a focused course, then helps you move through each topic with an AI tutor.
          </p>
          <div className="mt-7 flex flex-wrap gap-3 sm:mt-9">
            <Link href="/signup" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#642BD8] px-6 py-3 text-sm font-semibold text-white shadow-[0_12px_26px_-14px_rgba(81,68,198,0.8)] transition hover:-translate-y-0.5 hover:bg-[#5322B5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]">
              Start learning <ArrowUpRight aria-hidden="true" size={16} />
            </Link>
            <Link href="/signin" className="inline-flex min-h-12 items-center rounded-xl border border-[#EEE5E0] bg-white px-6 py-3 text-sm font-semibold text-[#514e69] transition hover:border-[#C5B1F1] hover:bg-[#FCF9FF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]">
              Sign in
            </Link>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-medium text-[#756B80] sm:mt-10">
            <span className="inline-flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#642BD8]" />Your goal shapes the course</span>
            <span className="inline-flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#a58ce9]" />Learn one topic at a time</span>
          </div>
        </section>

        <aside aria-label="Learning path illustration" className="relative mx-auto min-w-0 w-full max-w-[calc(100vw_-_2.5rem)] overflow-hidden rounded-[2rem] border border-[#E7DDF8] bg-[radial-gradient(ellipse_at_52%_38%,#fff_0%,#f6f3ff_54%,#eeebff_100%)] p-3 shadow-[0_32px_90px_-55px_rgba(67,55,157,0.48)] sm:max-w-[650px] sm:p-5 lg:justify-self-end">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(#b8afe9_0.75px,transparent_0.75px)] [background-size:18px_18px] [mask-image:linear-gradient(to_bottom,black,transparent_78%)]" />
          <div className="relative rounded-[1.5rem] border border-white/80 bg-white/50 p-2 backdrop-blur-sm sm:p-4">
            <svg aria-hidden="true" className="h-auto w-full drop-shadow-[0_24px_30px_rgba(70,57,158,0.12)]" fill="none" viewBox="0 0 620 470" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="book-cover" x1="164" x2="478" y1="112" y2="368" gradientUnits="userSpaceOnUse"><stop stopColor="#A78BFA"/><stop offset="1" stopColor="#642BD8"/></linearGradient>
                <linearGradient id="page-fill" x1="214" x2="407" y1="177" y2="330" gradientUnits="userSpaceOnUse"><stop stopColor="white"/><stop offset="1" stopColor="#F5F2FF"/></linearGradient>
                <linearGradient id="path-stroke" x1="105" x2="522" y1="357" y2="141" gradientUnits="userSpaceOnUse"><stop stopColor="#F8B4D0"/><stop offset="1" stopColor="#642BD8"/></linearGradient>
                <filter id="soft-shadow" x="119" y="83" width="402" height="338" colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="18"/></filter>
              </defs>
              <ellipse cx="320" cy="365" fill="#4A285F" fillOpacity=".12" filter="url(#soft-shadow)" rx="170" ry="36"/>
              <path d="M102 359C168 359 168 283 236 283C302 283 296 200 367 200C429 200 428 125 511 125" stroke="url(#path-stroke)" strokeDasharray="7 10" strokeLinecap="round" strokeWidth="5"/>
              <circle cx="103" cy="359" r="17" fill="white" stroke="#B8ABF1" strokeWidth="7"/>
              <circle cx="236" cy="283" r="16" fill="white" stroke="#9885E9" strokeWidth="7"/>
              <circle cx="367" cy="200" r="16" fill="white" stroke="#7A69DE" strokeWidth="7"/>
              <circle cx="511" cy="125" r="18" fill="#642BD8" stroke="white" strokeWidth="7"/>
              <path d="M204 148C204 135 215 125 229 128L313 147V333L226 314C213 311 204 300 204 287V148Z" fill="url(#book-cover)"/>
              <path d="M416 148C416 135 405 125 391 128L307 147V333L394 314C407 311 416 300 416 287V148Z" fill="url(#book-cover)"/>
              <path d="M221 151C221 143 228 138 237 140L301 155V310L237 296C228 294 221 287 221 278V151Z" fill="url(#page-fill)"/>
              <path d="M399 151C399 143 392 138 383 140L319 155V310L383 296C392 294 399 287 399 278V151Z" fill="url(#page-fill)"/>
              <path d="M310 151V314" stroke="#C7BDF3" strokeWidth="3"/>
              <path d="M239 177L280 187M239 193L280 203M239 209L271 217M341 187L381 177M341 203L381 193M350 219L381 211" stroke="#D5CFF2" strokeLinecap="round" strokeWidth="5"/>
              <path d="M287 327L310 346L333 327" stroke="#642BD8" strokeLinecap="round" strokeLinejoin="round" strokeWidth="6"/>
              <path d="M488 68L494 84L510 90L494 96L488 112L482 96L466 90L482 84L488 68Z" fill="#A58CE9"/>
              <path d="M151 193L155 203L165 207L155 211L151 221L147 211L137 207L147 203L151 193Z" fill="#C3B6F4"/>
            </svg>
          </div>
          <p className="relative mt-2 flex items-center justify-center gap-2 px-3 pb-2 text-center text-xs font-semibold tracking-wide text-[#756B80] sm:mt-3 sm:pb-1"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white text-[#642BD8] shadow-sm"><BookOpen aria-hidden="true" size={15} /></span>A personal path, built one lesson at a time</p>
        </aside>
      </main>

      <section aria-labelledby="learning-tools-heading" className="mx-auto max-w-[1440px] px-5 pb-16 sm:px-8 sm:pb-20 lg:px-12">
        <div className="mx-auto max-w-3xl text-center">
          <p className="learnos-eyebrow">A learning space that moves with you</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-[#29213D] sm:text-4xl" id="learning-tools-heading">Everything you need to make progress feel clear.</h2>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-[#756B80]">LearnOS connects your goal to a saved course, guided lessons, practice, and a place to return to what you have learned.</p>
        </div>
        <div className="mt-9 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <article className="learnos-card p-5 transition hover:-translate-y-0.5 hover:shadow-[0_18px_42px_-30px_rgba(74,40,95,0.32)]">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#F2ECFF] text-[#642BD8]"><BookOpen aria-hidden="true" size={21} /></span>
            <h3 className="mt-4 font-semibold text-[#29213D]">A course shaped around your goal</h3>
            <p className="mt-2 text-sm leading-6 text-[#756B80]">Turn a learning goal into a saved syllabus you can return to and follow topic by topic.</p>
          </article>
          <article className="learnos-card p-5 transition hover:-translate-y-0.5 hover:shadow-[0_18px_42px_-30px_rgba(74,40,95,0.32)]">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#FCEAF1] text-[#9D4D76]"><BrainCircuit aria-hidden="true" size={21} /></span>
            <h3 className="mt-4 font-semibold text-[#29213D]">An AI Tutor beside each lesson</h3>
            <p className="mt-2 text-sm leading-6 text-[#756B80]">Ask questions with your course topic in context, and use voice where supported.</p>
          </article>
          <article className="learnos-card p-5 transition hover:-translate-y-0.5 hover:shadow-[0_18px_42px_-30px_rgba(74,40,95,0.32)]">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#FFF0E5] text-[#A65E37]"><ClipboardCheck aria-hidden="true" size={21} /></span>
            <h3 className="mt-4 font-semibold text-[#29213D]">Practice, then review</h3>
            <p className="mt-2 text-sm leading-6 text-[#756B80]">Work through practice and mock tests, then revisit saved answers and feedback.</p>
          </article>
          <article className="learnos-card p-5 transition hover:-translate-y-0.5 hover:shadow-[0_18px_42px_-30px_rgba(74,40,95,0.32)]">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#EAF4EC] text-[#477653]"><ChartNoAxesCombined aria-hidden="true" size={21} /></span>
            <h3 className="mt-4 font-semibold text-[#29213D]">Keep your learning together</h3>
            <p className="mt-2 text-sm leading-6 text-[#756B80]">See course progress and keep tutor-created notes close to the topics they support.</p>
          </article>
        </div>
      </section>

      <section aria-labelledby="journey-heading" className="border-y border-[#EEE5E0] bg-white/65">
        <div className="mx-auto grid max-w-[1440px] gap-8 px-5 py-12 sm:px-8 sm:py-16 lg:grid-cols-[0.8fr_1.2fr] lg:items-center lg:px-12">
          <div>
            <p className="learnos-eyebrow">Your next step, made simple</p>
            <h2 className="mt-3 max-w-lg text-3xl font-semibold tracking-[-0.04em] text-[#29213D] sm:text-4xl" id="journey-heading">From an open goal to a steady learning rhythm.</h2>
            <p className="mt-4 max-w-lg text-base leading-7 text-[#756B80]">Start with what you want to learn. Your saved course keeps the path organized while you learn, ask, practice, and return.</p>
            <Link className="learnos-primary-button mt-6 inline-flex min-h-11 items-center gap-2 px-5 py-2.5 text-sm shadow-[0_12px_26px_-14px_rgba(83,34,181,0.7)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]" href="/signup">Build your learning path <ArrowUpRight aria-hidden="true" size={16} /></Link>
          </div>
          <ol className="grid gap-3 sm:grid-cols-3">
            <li className="rounded-2xl border border-[#EEE5E0] bg-white p-5"><span className="text-xs font-bold tracking-[0.14em] text-[#A78BFA]">01</span><h3 className="mt-3 font-semibold text-[#29213D]">Choose a goal</h3><p className="mt-2 text-sm leading-6 text-[#756B80]">Describe what you want to learn and how much time you have.</p></li>
            <li className="rounded-2xl border border-[#EEE5E0] bg-white p-5"><span className="text-xs font-bold tracking-[0.14em] text-[#D58BAA]">02</span><h3 className="mt-3 font-semibold text-[#29213D]">Learn with context</h3><p className="mt-2 text-sm leading-6 text-[#756B80]">Move through your saved syllabus with the AI Tutor close by.</p></li>
            <li className="rounded-2xl border border-[#EEE5E0] bg-white p-5"><span className="text-xs font-bold tracking-[0.14em] text-[#71977A]">03</span><h3 className="mt-3 font-semibold text-[#29213D]">Practice and revisit</h3><p className="mt-2 text-sm leading-6 text-[#756B80]">Review your attempts, course progress, and saved learning notes.</p></li>
          </ol>
        </div>
      </section>

      <footer className="mx-auto flex max-w-[1440px] flex-col gap-4 px-5 py-8 text-sm text-[#756B80] sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-12">
        <Link className="inline-flex items-center gap-2 font-semibold text-[#29213D]" href="/"><span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#642BD8] text-white"><BookOpen aria-hidden="true" size={16} /></span>LearnOS AI</Link>
        <p>A personal path, built one lesson at a time.</p>
        <nav aria-label="Footer" className="flex items-center gap-4"><Link className="font-medium hover:text-[#642BD8]" href="/signin">Sign in</Link><Link className="font-medium hover:text-[#642BD8]" href="/signup">Get started</Link></nav>
      </footer>
    </div>
  );
}
