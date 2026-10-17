"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDown, Check, Mic, MicOff, Pause, Play, PhoneOff, RotateCcw, Send } from "lucide-react";
import { useLiveTutor } from "@/lib/tutor-live";
import { useAuth } from "@/lib/auth-context";
import type { TutorReply, TutorState, TutorVisual, useTutor } from "@/lib/tutor";

function Visual({ visual }: { visual: TutorVisual }) {
  return (
    <figure className="my-4 min-w-0 max-w-full border-l-2 border-[#1b6657] pl-3 sm:pl-4">
      <figcaption className="mb-2 text-sm font-semibold text-[#1b302b]">{visual.title}</figcaption>
      {visual.kind === "code" && <pre className="max-h-72 max-w-full overflow-auto rounded-md border border-[#30443b] bg-[#17251f] p-3 font-mono text-xs leading-5 text-[#f0f7f1] shadow-inner"><code>{visual.code}</code></pre>}
      {visual.kind === "table" && <div className="max-w-full overflow-x-auto rounded-md border border-[#d9ddd5]"><table className="min-w-max border-collapse text-left text-xs"><thead><tr>{visual.columns.map((column, index) => <th className="border border-[#d9ddd5] bg-[#edf0e9] p-2 font-semibold" key={index} scope="col">{column}</th>)}</tr></thead><tbody>{visual.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td className="border border-[#d9ddd5] p-2 align-top" key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>}
      {(visual.kind === "steps" || visual.kind === "flow") && <ol className="space-y-2 text-sm">{visual.steps.map((step, index) => <li key={index}>{visual.kind === "flow" && index > 0 && <ArrowDown aria-hidden="true" className="my-2 text-[#1b6657]" size={16} />}<div className={visual.kind === "flow" ? "border border-[#d9ddd5] bg-[#f0f7f1] p-2" : ""}><span className="mr-2 font-semibold">{index + 1}.</span>{step}</div></li>)}</ol>}
    </figure>
  );
}

function Explanation({ reply }: { reply: TutorReply }) {
  return <div className="max-w-prose space-y-3 text-sm leading-6 text-[#34423c]"><h4 className="text-base font-semibold leading-6 text-[#1b302b]">{reply.concept_title}</h4><p className="whitespace-pre-wrap">{reply.explanation}</p><div><h5 className="mb-1 font-semibold text-[#1b302b]">Example</h5><p className="whitespace-pre-wrap">{reply.example}</p></div>{reply.visuals.map((visual, index) => <Visual key={index} visual={visual} />)}<p className="rounded-md bg-[#f0f7f1] p-3 font-medium text-[#1b6657]">{reply.check_question}</p></div>;
}

function formatConnectionTime(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ConversationMessage({ message }: { message: TutorState["conversation"]["messages"][number] }) {
  return <article className={message.role === "user" ? "ml-auto w-fit max-w-[88%] break-words rounded-3xl rounded-br-md bg-[#eaf4ef] px-4 py-3" : "mr-auto min-w-0 max-w-full break-words py-1"}><p className="mb-2 text-xs font-semibold text-[#68736d]">{message.role === "user" ? "You" : "LearnOS Tutor"}{message.channel === "voice" ? " · Live voice" : ""}</p><div className="min-w-0 break-words">{message.reply?.intent === "redirect" ? <p className="whitespace-pre-wrap text-sm leading-6 text-[#34423c]">{message.reply.redirect_message}</p> : message.reply ? <Explanation reply={message.reply} /> : <p className="whitespace-pre-wrap text-sm leading-6 text-[#34423c]">{message.text}</p>}</div></article>;
}

export function AiTutor({ courseId, controller, lesson, nextTopicId, moduleReady }: {
  courseId: string;
  controller: ReturnType<typeof useTutor>;
  lesson?: { topic_id: string; title: string; description: string; moduleTitle: string; estimated_minutes: number };
  nextTopicId?: string;
  moduleReady: boolean;
}) {
  const { state, loading, busy, error, perform, reload, acceptSavedState } = controller;
  const { user } = useAuth();
  const learnerName = (state?.learner_name !== "Learner" ? state?.learner_name : "")
    || user?.displayName?.trim() || "";
  const [draft, setDraft] = useState("");
  const [pendingMessage, setPendingMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<Parameters<typeof perform>[0] | null>(null);
  const [mode, setMode] = useState<"chat" | "voice">("chat");
  const input = useRef<HTMLTextAreaElement>(null);
  const conversationArea = useRef<HTMLDivElement>(null);
  const live = useLiveTutor(courseId, lesson?.topic_id ?? "", state?.progress_epoch ?? 0, acceptSavedState);
  const messages = state?.conversation.messages ?? [];
  let currentExchangeStart = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      currentExchangeStart = index > 0 && messages[index - 1].role === "user" ? index - 1 : index;
      break;
    }
  }
  const paused = state?.paused ?? false;
  const completed = !!lesson && state?.topic_status[lesson.topic_id] === "completed";
  const disabled = loading || busy || !state || paused;
  const liveConnected = live.status === "connected";
  const currentConcept = state?.conversation.concepts[state.conversation.concept_index];
  const awaitingResponse = !!currentConcept && !state?.can_confirm
    && messages.some((message) => message.reply?.concept_title === currentConcept);

  useEffect(() => {
    const area = conversationArea.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [state?.active_topic_id, state?.conversation.messages, live.partialTranscript]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || disabled) return;
    if (mode === "voice") {
      if (live.sendText(message)) setDraft("");
      return;
    }
    setDraft("");
    setPendingMessage(message);
    await perform("message", undefined, message);
    setPendingMessage("");
  }

  async function act(action: Parameters<typeof perform>[0], topicId?: string) {
    if (live.status !== "idle") await live.disconnect();
    setPendingAction(action);
    try {
      if (await perform(action, topicId)) setDraft("");
    } finally {
      setPendingAction(null);
    }
  }

  async function explainVisually() {
    if (live.status !== "idle") await live.disconnect();
    const message = "Please explain the current topic with a useful flow diagram or table if one would help.";
    setPendingMessage(message);
    await perform("message", undefined, message);
    setPendingMessage("");
  }

  return <section aria-labelledby="tutor-heading" className="flex min-w-0 max-w-full flex-col border-t border-[#e0e2d9] bg-[#fbfcfa] lg:sticky lg:top-6 lg:h-[calc(100dvh-3rem)] lg:min-h-[36rem] lg:self-start lg:border-t-0">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#e0e2d9] bg-white px-4 py-4 sm:px-5">
      <h2 className="text-base font-semibold" id="tutor-heading">AI Tutor</h2>
      <div aria-label="Tutor mode" className="inline-flex rounded-md border border-[#d9ddd5] p-1" role="group">{(["chat", "voice"] as const).map((choice) => <button aria-pressed={mode === choice} className={`rounded px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] ${mode === choice ? "bg-[#1b6657] text-white" : "text-[#586761] hover:bg-[#f0f7f1]"}`} key={choice} onClick={() => { if (choice === "chat" && live.status !== "idle") void live.disconnect(); setMode(choice); }} type="button">{choice === "chat" ? "Chat" : "Live voice"}</button>)}</div>
    </header>
    <div aria-live="polite" className="max-h-40 shrink-0 overflow-auto border-b border-[#e0e2d9] bg-[#f6f8f5] px-4 py-3 sm:px-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#68736d]">{paused ? "Paused" : liveConnected ? "Live lesson" : "Active lesson"}</p>
      <h3 className="mt-1 break-words font-semibold">{lesson?.title ?? "No saved lesson available"}</h3>
      {lesson && <p className="mt-1 break-words text-xs text-[#68736d]">{lesson.moduleTitle} · {lesson.estimated_minutes} minutes</p>}
      {!!state?.conversation.concepts.length && <p className="mt-2 text-xs text-[#1b6657]">Concept {state.conversation.concept_index + 1} of {state.conversation.concepts.length}: {state.conversation.concepts[state.conversation.concept_index]}</p>}
    </div>
    <div className="flex shrink-0 justify-end border-b border-[#e0e2d9] px-4 py-2 sm:px-5">
      <button className="inline-flex items-center gap-1.5 rounded-md border border-[#d9ddd5] px-2.5 py-1.5 text-xs font-semibold text-[#586761] hover:bg-[#f0f7f1] disabled:opacity-50" disabled={loading || busy || !state} onClick={() => {
        if (window.confirm("Restart this course from the beginning? Saved progress and tutor conversations will be reset.")) void act("restart");
      }} type="button"><RotateCcw aria-hidden="true" size={13} />Restart course</button>
    </div>
    <div aria-label="Tutor conversation" aria-live="polite" aria-relevant="additions" className="max-h-[32rem] min-h-48 min-w-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-4 py-5 sm:px-5 lg:max-h-none lg:min-h-0" ref={conversationArea} role="log">
      {loading && <p className="text-sm text-[#68736d]">Loading saved conversation and progress...</p>}
      {!loading && messages.length === 0 && <div className="py-5"><p className="font-semibold">Hi{learnerName ? ` ${learnerName.split(/\s+/)[0]}` : ""}! {lesson ? `Ready to learn ${lesson.title} together?` : "Your tutor needs a saved syllabus."}</p><p className="mt-2 text-sm text-[#68736d]">We’ll take one small step at a time. Ask questions whenever you like.</p></div>}
      {currentExchangeStart > 0 && <details className="rounded-md border border-[#e0e2d9] bg-[#f6f8f5] p-3" key={`${courseId}-${lesson?.topic_id}`}><summary className="cursor-pointer text-xs font-semibold text-[#586761]">Earlier conversation ({currentExchangeStart} messages)</summary><div className="mt-3 space-y-4">{messages.slice(0, currentExchangeStart).map((message, index) => <ConversationMessage key={index} message={message} />)}</div></details>}
      {messages.slice(currentExchangeStart).map((message, index) => <ConversationMessage key={currentExchangeStart + index} message={message} />)}
      {pendingMessage && <article className="ml-auto w-fit max-w-[88%] rounded-3xl rounded-br-md bg-[#eaf4ef] px-4 py-3"><p className="mb-2 text-xs font-semibold text-[#68736d]">You · Sending</p><p className="whitespace-pre-wrap break-words text-sm">{pendingMessage}</p></article>}
      {live.partialTranscript && <article className="max-w-full rounded-md border border-[#d9ddd5] bg-white/70 p-3"><p className="mb-2 text-xs font-semibold text-[#68736d]">Live transcript</p><p className="whitespace-pre-wrap break-words text-sm leading-6 text-[#34423c]">{live.partialTranscript}</p></article>}
      {busy && <p className="text-sm text-[#68736d]" role="status">Tutor request in progress. Your saved progress is safe.</p>}
      {error && <p className="text-sm text-red-800" role="alert">{error}</p>}
      {live.error && <p className="text-sm text-red-800" role="alert">{live.error}</p>}
      {live.hasUnsaved && <div className="flex flex-wrap items-center gap-2 text-xs text-[#586761]" role="status"><span>Some live transcript turns are still waiting to save.</span><button className="rounded-md border border-[#d9ddd5] px-2 py-1 font-semibold" onClick={() => void live.retrySave()} type="button">Retry saving transcript</button></div>}
    </div>
    <div className="shrink-0 border-t border-[#e0e2d9] bg-[#fbfcfa] px-4 py-3 sm:px-5">
      {paused && <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#eadfc8] bg-[#fbf8f1] p-3" role="status">
        <p className="text-sm leading-5 text-[#586761]">This lesson is paused. Resume it from Lesson controls to continue learning.</p>
      </div>}
      <details className="group">
        <summary className="w-fit cursor-pointer rounded-md px-2 py-1 text-xs font-semibold text-[#586761] hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-[#1b6657]">Lesson controls</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <button aria-label={paused ? "Resume lesson" : "Pause lesson"} className="rounded-md border border-[#d9ddd5] p-2 transition-colors hover:bg-[#f0f7f1] disabled:opacity-50" disabled={loading || busy || !state} onClick={() => void act(paused ? "resume" : "pause")} title={paused ? "Resume lesson" : "Pause lesson"} type="button">{paused ? <Play aria-hidden="true" size={15} /> : <Pause aria-hidden="true" size={15} />}</button>
        {state?.can_confirm && <button className="rounded-md bg-[#1b6657] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#145344] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void act("confirm")} type="button"><Check aria-hidden="true" className="mr-1 inline" size={14} />{pendingAction === "confirm" ? "Saving…" : "I understand · Continue"}</button>}
        {!!messages.length && <><button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold transition hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void act("explain")} type="button">{pendingAction === "explain" ? "Preparing explanation…" : "Explain another way"}</button><button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold transition hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]" onClick={() => input.current?.focus()} type="button">Ask a question</button><button aria-label="Repeat lesson" className="rounded-md border border-[#d9ddd5] p-2 transition hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void act("repeat")} title="Repeat lesson" type="button"><RotateCcw aria-hidden="true" size={14} /></button></>}
        {moduleReady && <button className="rounded-md border border-[#1b6657] px-3 py-2 text-xs font-semibold text-[#1b6657] disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void act("confirm_module")} type="button">Confirm module completion</button>}
        {completed && nextTopicId && !moduleReady && <button className="rounded-md border border-[#1b6657] px-3 py-2 text-xs font-semibold text-[#1b6657] disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void act("select", nextTopicId)} type="button">Next lesson</button>}
        {mode === "voice" && lesson && <button className="rounded-md border border-[#1b6657] px-3 py-2 text-xs font-semibold text-[#1b6657] disabled:opacity-50" disabled={loading || busy || paused} onClick={() => void explainVisually()} type="button">Explain visually</button>}
        {(error || state?.busy) && <button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold" onClick={() => void reload()} type="button">Reload saved state</button>}
        </div>
      </details>
      {awaitingResponse && !completed && <p className="mt-2 text-xs text-[#1b6657]" role="status">Your turn: answer the tutor’s question below. The tutor will wait before continuing.</p>}
      {completed && <p className="mt-2 text-xs font-semibold text-[#1b6657]">Topic completed by your confirmation.</p>}
    </div>
    {mode === "voice" && <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[#e0e2d9] bg-[#f6f8f5] px-4 py-3 sm:px-5">
      {live.status === "idle" && <button className="rounded-md bg-[#1b6657] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={disabled || !lesson} onClick={() => void live.connect()} type="button"><Mic aria-hidden="true" className="mr-2 inline" size={16} />Start session</button>}
      {live.status === "connecting" && <div className="flex w-full flex-wrap items-center gap-3 text-sm text-[#586761]" role="status"><span>Connecting to your live tutor and microphone… {formatConnectionTime(live.connectingSeconds)} / 1:00</span><button className="rounded-md border border-[#d9ddd5] px-2.5 py-1.5 text-xs font-semibold hover:bg-white" onClick={() => void live.disconnect(false)} type="button">Cancel</button></div>}
      {liveConnected && <><button aria-label={live.muted ? "Unmute microphone" : "Mute microphone"} className="rounded-md border border-[#d9ddd5] p-2" onClick={live.toggleMute} title={live.muted ? "Unmute microphone" : "Mute microphone"} type="button">{live.muted ? <MicOff aria-hidden="true" size={18} /> : <Mic aria-hidden="true" size={18} />}</button><span className="text-xs text-[#586761]">{live.muted ? "Microphone muted" : live.speaking ? "Tutor is speaking · interrupt anytime" : "Live · listening for your voice"}</span><button className="ml-auto rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold" onClick={() => void live.disconnect()} type="button"><PhoneOff aria-hidden="true" className="mr-1 inline" size={14} />Stop session</button></>}
      <p className="w-full text-xs text-[#68736d]">Your audio streams to Gemini for the live conversation. Text transcripts are saved with this course; raw audio is not stored.</p>
    </div>}
    <form className="shrink-0 border-t border-[#e0e2d9] bg-white p-5" onSubmit={submit}>
      <label className="sr-only" htmlFor="tutor-message">Question about the active lesson</label>
      <textarea className="block w-full resize-none rounded-md border border-[#d9ddd5] p-3 text-sm outline-none transition focus:border-[#1b6657] focus:ring-2 focus:ring-[#1b6657]/20 disabled:bg-[#f6f8f5]" disabled={disabled || !lesson || (mode === "voice" && !liveConnected)} id="tutor-message" maxLength={2000} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} placeholder={mode === "voice" ? liveConnected ? "Type a question or speak naturally…" : "Start a live lesson to use voice" : paused ? "Resume the lesson to continue" : "Ask about this course concept…"} ref={input} rows={2} value={draft} />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[#68736d]">{mode === "voice" ? "The tutor listens and responds in real time. You can interrupt, ask a doubt, or type while connected." : "The tutor uses your saved course material and waits for your response before offering the next step."}</p>
        <button className="inline-flex items-center gap-2 rounded-md bg-[#1b6657] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={disabled || !draft.trim() || (mode === "voice" && !liveConnected)} type="submit"><Send aria-hidden="true" size={16} />{mode === "voice" ? "Send live" : "Send"}</button>
      </div>
    </form>
  </section>;
}
