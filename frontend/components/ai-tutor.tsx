"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDown, Check, Mic, MicOff, Pause, Play, PhoneOff, RotateCcw, Send, Sparkles, Square } from "lucide-react";
import { useLiveTutor } from "@/lib/tutor-live";
import { useAuth } from "@/lib/auth-context";
import type { TutorReply, TutorState, TutorVisual, useTutor } from "@/lib/tutor";

function Visual({ visual }: { visual: TutorVisual }) {
  return (
    <figure className="my-4 min-w-0 max-w-full border-l-2 border-[#642BD8] pl-3 sm:pl-4">
      <figcaption className="mb-2 text-sm font-semibold text-[#29213D]">{visual.title}</figcaption>
      {visual.kind === "code" && <pre className="max-h-72 max-w-full overflow-auto rounded-md border border-[#30443b] bg-[#17251f] p-3 font-mono text-xs leading-5 text-[#F2ECFF] shadow-inner"><code>{visual.code}</code></pre>}
      {visual.kind === "table" && <div className="max-w-full overflow-x-auto rounded-md border border-[#EEE5E0]"><table className="min-w-max border-collapse text-left text-xs"><thead><tr>{visual.columns.map((column, index) => <th className="border border-[#EEE5E0] bg-[#EEE5E0] p-2 font-semibold" key={index} scope="col">{column}</th>)}</tr></thead><tbody>{visual.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td className="border border-[#EEE5E0] p-2 align-top" key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>}
      {(visual.kind === "steps" || visual.kind === "flow") && <ol className="space-y-2 text-sm">{visual.steps.map((step, index) => <li key={index}>{visual.kind === "flow" && index > 0 && <ArrowDown aria-hidden="true" className="my-2 text-[#642BD8]" size={16} />}<div className={visual.kind === "flow" ? "border border-[#EEE5E0] bg-[#F2ECFF] p-2" : ""}><span className="mr-2 font-semibold">{index + 1}.</span>{step}</div></li>)}</ol>}
    </figure>
  );
}

function Explanation({ reply }: { reply: TutorReply }) {
  return <div className="max-w-prose space-y-3 text-sm leading-6 text-[#424158]"><h4 className="text-base font-semibold leading-6 text-[#29213D]">{reply.concept_title}</h4><p className="whitespace-pre-wrap">{reply.explanation}</p><div><h5 className="mb-1 font-semibold text-[#29213D]">Example</h5><p className="whitespace-pre-wrap">{reply.example}</p></div>{reply.visuals.map((visual, index) => <Visual key={index} visual={visual} />)}<p className="rounded-md bg-[#F2ECFF] p-3 font-medium text-[#642BD8]">{reply.check_question}</p></div>;
}

function formatConnectionTime(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ConversationMessage({ message }: { message: TutorState["conversation"]["messages"][number] }) {
  return <article className={message.role === "user" ? "ml-auto w-fit max-w-[88%] break-words rounded-3xl rounded-br-md bg-[#F2ECFF] px-4 py-3" : "mr-auto min-w-0 max-w-full break-words py-1"}><p className="mb-2 text-xs font-semibold text-[#756B80]">{message.role === "user" ? "You" : "LearnOS Tutor"}{message.channel === "voice" ? " · Live voice" : ""}</p><div className="min-w-0 break-words">{message.reply?.intent === "redirect" ? <p className="whitespace-pre-wrap text-sm leading-6 text-[#424158]">{message.reply.redirect_message}</p> : message.reply ? <Explanation reply={message.reply} /> : <p className="whitespace-pre-wrap text-sm leading-6 text-[#424158]">{message.text}</p>}</div></article>;
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
  const nearBottom = useRef(true);
  const scrollSnapshot = useRef<{ height: number; top: number } | null>(null);
  const live = useLiveTutor(courseId, lesson?.topic_id ?? "", state?.progress_epoch ?? 0, acceptSavedState);
  const previousTopicId = useRef(lesson?.topic_id ?? "");
  const messages = controller.messages;
  const firstMessageId = messages[0]?.id;
  const lastMessageId = messages.at(-1)?.id;
  const paused = state?.paused ?? false;
  const completed = !!lesson && state?.topic_status[lesson.topic_id] === "completed";
  const disabled = loading || busy || !state || paused;
  const liveConnected = live.status === "connected";
  const currentConcept = state?.conversation.concepts[state.conversation.concept_index];
  const finalConcept = !!state?.conversation.concepts.length
    && state.conversation.concept_index === state.conversation.concepts.length - 1;
  const awaitingResponse = !!currentConcept && !state?.can_confirm
    && messages.some((message) => message.reply?.concept_title === currentConcept);

  useEffect(() => {
    const area = conversationArea.current;
    if (!area) return;
    if (scrollSnapshot.current && controller.historyLoading) return;
    if (scrollSnapshot.current) {
      area.scrollTop = scrollSnapshot.current.top + area.scrollHeight - scrollSnapshot.current.height;
      scrollSnapshot.current = null;
    } else if (nearBottom.current) {
      area.scrollTop = area.scrollHeight;
    }
  }, [messages.length, firstMessageId, lastMessageId, live.partialTranscript, pendingMessage, controller.historyLoading]);

  useEffect(() => {
    nearBottom.current = true;
    scrollSnapshot.current = null;
    const area = conversationArea.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [state?.active_topic_id, state?.progress_epoch]);

  async function loadOlder() {
    const area = conversationArea.current;
    if (area) scrollSnapshot.current = { height: area.scrollHeight, top: area.scrollTop };
    await controller.loadOlderMessages();
  }

  useEffect(() => {
    const topicId = lesson?.topic_id ?? "";
    if (previousTopicId.current === topicId) return;
    previousTopicId.current = topicId;
    if (topicId && mode === "voice" && live.status !== "idle") {
      void live.disconnect(false);
    }
  }, [lesson?.topic_id, live.disconnect, live.status, mode]);

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

  return <section aria-labelledby="tutor-heading" className="flex min-w-0 max-w-full flex-col rounded-2xl border border-[#EEE5E0] bg-[#FFFCF9] shadow-[0_18px_50px_-40px_rgba(74,40,95,0.28)] lg:sticky lg:top-6 lg:h-[calc(100dvh-3rem)] lg:min-h-[36rem] lg:self-start">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-t-2xl border-b border-[#EEE5E0] bg-white px-4 py-4 sm:px-5">
      <h2 className="flex items-center gap-2 text-base font-semibold" id="tutor-heading"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#F2ECFF] text-[#642BD8]"><Sparkles aria-hidden="true" size={16} /></span>AI Tutor</h2>
      <div aria-label="Tutor mode" className="inline-flex rounded-md border border-[#EEE5E0] p-1" role="group">{(["chat", "voice"] as const).map((choice) => <button aria-pressed={mode === choice} className={`rounded px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8] ${mode === choice ? "bg-[#642BD8] text-white" : "text-[#756B80] hover:bg-[#F2ECFF]"}`} key={choice} onClick={() => { void (async () => { if (choice === "chat" && live.status !== "idle") await live.disconnect(); setMode(choice); })(); }} type="button">{choice === "chat" ? "Chat" : "Live voice"}</button>)}</div>
    </header>
    <div aria-live="polite" className="max-h-40 shrink-0 overflow-auto border-b border-[#EEE5E0] bg-[#F2ECFF] px-4 py-3 sm:px-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#756B80]">{paused ? "Paused" : liveConnected ? "Live lesson" : "Active lesson"}</p>
      <h3 className="mt-1 break-words font-semibold">{lesson?.title ?? "No saved lesson available"}</h3>
      {lesson && <p className="mt-1 break-words text-xs text-[#756B80]">{lesson.moduleTitle} · {lesson.estimated_minutes} minutes</p>}
      {!!state?.conversation.concepts.length && <p className="mt-2 text-xs text-[#642BD8]">Concept {state.conversation.concept_index + 1} of {state.conversation.concepts.length}: {state.conversation.concepts[state.conversation.concept_index]}</p>}
    </div>
    <div className="flex shrink-0 justify-end border-b border-[#EEE5E0] px-4 py-2 sm:px-5">
      <button className="inline-flex items-center gap-1.5 rounded-md border border-[#EEE5E0] px-2.5 py-1.5 text-xs font-semibold text-[#756B80] hover:bg-[#F2ECFF] disabled:opacity-50" disabled={loading || busy || !state} onClick={() => {
        if (window.confirm("Restart this course from the beginning? Saved progress and tutor conversations will be reset.")) void act("restart");
      }} type="button"><RotateCcw aria-hidden="true" size={13} />Restart course</button>
    </div>
    <div aria-label="Tutor conversation" aria-live="polite" aria-relevant="additions" className="max-h-[32rem] min-h-48 min-w-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-4 py-5 sm:px-5 lg:max-h-none lg:min-h-0" onScroll={() => {
      const area = conversationArea.current;
      if (!area) return;
      nearBottom.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
      if (area.scrollTop < 60 && controller.hasOlderMessages && !controller.historyLoading && !controller.historyError) void loadOlder();
    }} ref={conversationArea} role="log">
      {loading && <p className="text-sm text-[#756B80]">Loading saved conversation and progress...</p>}
      {controller.historyLoading && <p className="text-xs text-[#756B80]" role="status">Loading saved messages...</p>}
      {(controller.hasOlderMessages || controller.historyError) && <div className="text-xs text-[#756B80]">{controller.historyError && <p role="status">{controller.historyError}</p>}<button className="rounded-md border border-[#EEE5E0] px-3 py-2 font-semibold disabled:opacity-50" disabled={controller.historyLoading} onClick={() => void loadOlder()} type="button">{controller.historyError ? "Retry loading messages" : "Load older messages"}</button></div>}
      {!loading && messages.length === 0 && <div className="py-5"><p className="font-semibold">Hi{learnerName ? ` ${learnerName.split(/\s+/)[0]}` : ""}! {lesson ? `Ready to learn ${lesson.title} together?` : "Your tutor needs a saved syllabus."}</p><p className="mt-2 text-sm text-[#756B80]">We’ll take one small step at a time. Ask questions whenever you like.</p></div>}
      {messages.map((message, index) => <ConversationMessage key={message.id ?? index} message={message} />)}
      {pendingMessage && <article className="ml-auto w-fit max-w-[88%] rounded-3xl rounded-br-md bg-[#F2ECFF] px-4 py-3"><p className="mb-2 text-xs font-semibold text-[#756B80]">You · Sending</p><p className="whitespace-pre-wrap break-words text-sm">{pendingMessage}</p></article>}
      {live.partialTranscript && <article className="max-w-full rounded-md border border-[#EEE5E0] bg-white/70 p-3"><p className="mb-2 text-xs font-semibold text-[#756B80]">Live transcript</p><p className="whitespace-pre-wrap break-words text-sm leading-6 text-[#424158]">{live.partialTranscript}</p></article>}
      {busy && !error && <p className="text-sm text-[#756B80]" role="status">Your tutor is working on this step. Thanks for your patience.</p>}
      {controller.stopped && !busy && <div className="rounded-md bg-[#F2ECFF] p-3 text-sm text-[#424158]" role="status"><p>Response stopped. Your saved chat and progress are still here. Send another message whenever you&apos;re ready.</p><button className="mt-2 rounded-md border border-[#642BD8] px-3 py-2 text-xs font-semibold text-[#642BD8] disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void perform("message", undefined, "Please continue the current concept.")} type="button">Continue chat</button></div>}
      {error && <div className="rounded-xl border border-[#EEE5E0] bg-[#F2ECFF] p-4 text-sm text-[#424158]" role="status">
        <p className="font-semibold text-[#4A285F]">Let&apos;s get your lesson back on track</p>
        <p className="mt-1 leading-6">{error}</p>
        <button className="mt-3 rounded-md border border-[#642BD8] px-3 py-2 text-xs font-semibold text-[#642BD8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8] disabled:opacity-50" disabled={loading || busy && !state?.busy} onClick={() => void reload()} type="button">{loading ? "Checking your lesson..." : "Check saved lesson"}</button>
        <p className="mt-2 text-xs text-[#756B80]">We&apos;ll check your saved progress first. Once it loads, you can try your last step again.</p>
      </div>}
      {live.error && <div className="rounded-xl border border-[#EEE5E0] bg-[#F2ECFF] p-4 text-sm text-[#424158]" role="status"><p className="font-semibold text-[#4A285F]">Let&apos;s reconnect with your tutor</p><p className="mt-1 leading-6">{live.error}</p><p className="mt-2 text-xs text-[#756B80]">You can use Retry in the voice controls or switch to chat to keep learning.</p></div>}
      {live.hasUnsaved && <div className="flex flex-wrap items-center gap-2 text-xs text-[#756B80]" role="status"><span>Some live transcript turns are still waiting to save.</span><button className="rounded-md border border-[#EEE5E0] px-2 py-1 font-semibold" onClick={() => void live.retrySave()} type="button">Retry saving transcript</button></div>}
    </div>
    <div className="shrink-0 border-t border-[#EEE5E0] bg-[#FFF8F1] px-4 py-3 sm:px-5">
      {paused && <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#eadfc8] bg-[#fbf8f1] p-3" role="status">
        <p className="text-sm leading-5 text-[#756B80]">This lesson is paused. Resume it from Lesson controls to continue learning.</p>
      </div>}
      <div className="mb-2 flex flex-wrap gap-2">
        {lesson && currentConcept && !completed && <button className="rounded-xl bg-[#642BD8] px-3.5 py-2.5 text-xs font-semibold text-white transition hover:bg-[#5322B5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8] disabled:opacity-50" disabled={disabled || liveConnected || !state?.can_confirm} onClick={() => void act("confirm")} type="button"><Check aria-hidden="true" className="mr-1 inline" size={14} />{pendingAction === "confirm" ? "Saving…" : finalConcept ? "Mark as complete" : "I understand · Continue"}</button>}
        {moduleReady && <button className="rounded-md border border-[#642BD8] px-3 py-2 text-xs font-semibold text-[#642BD8] disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void act("confirm_module")} type="button">Confirm module completion</button>}
        {completed && nextTopicId && !moduleReady && <button className="rounded-md border border-[#642BD8] px-3 py-2 text-xs font-semibold text-[#642BD8] disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void act("select", nextTopicId)} type="button">Next lesson</button>}
      </div>
      {finalConcept && !completed && <p className="mb-2 text-xs text-[#756B80]">Mark this topic as complete to save your progress and queue its notes.</p>}
      <details className="group">
        <summary className="w-fit cursor-pointer rounded-md px-2 py-1 text-xs font-semibold text-[#756B80] hover:bg-[#F2ECFF] focus-visible:outline-2 focus-visible:outline-[#642BD8]">Lesson controls</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <button aria-label={paused ? "Resume lesson" : "Pause lesson"} className="rounded-md border border-[#EEE5E0] p-2 transition-colors hover:bg-[#F2ECFF] disabled:opacity-50" disabled={loading || busy || !state} onClick={() => void act(paused ? "resume" : "pause")} title={paused ? "Resume lesson" : "Pause lesson"} type="button">{paused ? <Play aria-hidden="true" size={15} /> : <Pause aria-hidden="true" size={15} />}</button>
        {!!messages.length && <><button className="rounded-md border border-[#EEE5E0] px-3 py-2 text-xs font-semibold transition hover:bg-[#F2ECFF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void act("explain")} type="button">{pendingAction === "explain" ? "Preparing explanation…" : "Explain another way"}</button><button className="rounded-md border border-[#EEE5E0] px-3 py-2 text-xs font-semibold transition hover:bg-[#F2ECFF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8]" onClick={() => input.current?.focus()} type="button">Ask a question</button><button aria-label="Repeat lesson" className="rounded-md border border-[#EEE5E0] p-2 transition hover:bg-[#F2ECFF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8] disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void act("repeat")} title="Repeat lesson" type="button"><RotateCcw aria-hidden="true" size={14} /></button></>}
        {mode === "voice" && lesson && <button className="rounded-md border border-[#642BD8] px-3 py-2 text-xs font-semibold text-[#642BD8] disabled:opacity-50" disabled={loading || busy || paused} onClick={() => void explainVisually()} type="button">Explain visually</button>}
        {(error || state?.busy) && <button className="rounded-md border border-[#EEE5E0] px-3 py-2 text-xs font-semibold" onClick={() => void reload()} type="button">Reload saved state</button>}
        </div>
      </details>
      {awaitingResponse && !completed && <p className="mt-2 text-xs text-[#642BD8]" role="status">Your turn: answer the tutor’s question below. The tutor will wait before continuing.</p>}
      {completed && <p className="mt-2 text-xs font-semibold text-[#642BD8]">Topic completed by your confirmation.</p>}
    </div>
    {mode === "voice" && <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[#EEE5E0] bg-[#F2ECFF] px-4 py-3 sm:px-5">
      {live.status === "idle" && <button className="rounded-md bg-[#642BD8] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={disabled || !lesson} onClick={() => void live.connect()} type="button"><Mic aria-hidden="true" className="mr-2 inline" size={16} />{live.error ? "Retry" : "Start session"}</button>}
      {live.status === "connecting" && <div className="flex w-full flex-wrap items-center gap-3 text-sm text-[#756B80]" role="status"><span>Connecting to your live tutor and microphone… {formatConnectionTime(live.connectingSeconds)} / 1:00</span><button className="rounded-md border border-[#EEE5E0] px-2.5 py-1.5 text-xs font-semibold hover:bg-white" onClick={() => void live.disconnect(false)} type="button">Cancel</button></div>}
      {liveConnected && <><button aria-label={live.muted ? "Unmute microphone" : "Mute microphone"} className="rounded-md border border-[#EEE5E0] p-2" onClick={live.toggleMute} title={live.muted ? "Unmute microphone" : "Mute microphone"} type="button">{live.muted ? <MicOff aria-hidden="true" size={18} /> : <Mic aria-hidden="true" size={18} />}</button><span className="text-xs text-[#756B80]">{live.muted ? "Microphone muted" : live.speaking ? "Tutor is speaking · interrupt anytime" : "Live · listening for your voice"}</span><button className="ml-auto rounded-md border border-[#EEE5E0] px-3 py-2 text-xs font-semibold" onClick={() => void live.disconnect()} type="button"><PhoneOff aria-hidden="true" className="mr-1 inline" size={14} />Stop session</button></>}
      <p className="w-full text-xs text-[#756B80]">Your audio streams to Gemini for the live conversation. Text transcripts are saved with this course; raw audio is not stored.</p>
    </div>}
    <form className="shrink-0 border-t border-[#EEE5E0] bg-white p-5" onSubmit={submit}>
      <label className="sr-only" htmlFor="tutor-message">Question about the active lesson</label>
      <textarea className="block w-full resize-none rounded-md border border-[#EEE5E0] p-3 text-sm outline-none transition focus:border-[#642BD8] focus:ring-2 focus:ring-[#642BD8]/20 disabled:bg-[#F2ECFF]" disabled={disabled || !lesson || (mode === "voice" && !liveConnected)} id="tutor-message" maxLength={2000} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} placeholder={mode === "voice" ? liveConnected ? "Type a question or speak naturally…" : "Start a live lesson to use voice" : paused ? "Resume the lesson to continue" : "Ask about this course concept…"} ref={input} rows={2} value={draft} />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[#756B80]">{mode === "voice" ? "The tutor listens and responds in real time. You can interrupt, ask a doubt, or type while connected." : "The tutor uses your saved course material and waits for your response before offering the next step."}</p>
        {mode === "chat" && controller.canStop ? <button className="inline-flex items-center gap-2 rounded-md border border-[#642BD8] px-4 py-2 text-sm font-semibold text-[#642BD8] disabled:opacity-50" disabled={controller.stopping} onClick={() => void controller.stopResponse()} type="button"><Square aria-hidden="true" size={16} />{controller.stopping ? "Stopping..." : "Stop response"}</button> : <button className="learnos-primary-button inline-flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50" disabled={disabled || !draft.trim() || (mode === "voice" && !liveConnected)} type="submit"><Send aria-hidden="true" size={16} />{mode === "voice" ? "Send live" : "Send"}</button>}
      </div>
    </form>
  </section>;
}
