"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ArrowDown, Check, Mic, Pause, Play, RotateCcw, Send, Square, Volume2, VolumeX } from "lucide-react";
import type { TutorReply, TutorVisual, useTutor } from "@/lib/tutor";

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { results: { [index: number]: { [index: number]: { transcript: string } } } }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
const subscribe = () => () => {};
const hasRecognition = () => typeof window !== "undefined" && !!((window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition);
const hasSpeech = () => typeof window !== "undefined" && "speechSynthesis" in window;

function Visual({ visual }: { visual: TutorVisual }) {
  return (
    <figure className="my-3 min-w-0 border-l-2 border-[#1b6657] pl-3">
      <figcaption className="mb-2 text-sm font-semibold">{visual.title}</figcaption>
      {visual.kind === "code" && <pre className="max-h-64 overflow-auto rounded-md bg-[#17251f] p-3 text-xs leading-6 text-[#f0f7f1]"><code>{visual.code}</code></pre>}
      {visual.kind === "table" && <div className="overflow-x-auto"><table className="w-full border-collapse text-left text-xs"><thead><tr>{visual.columns.map((column, index) => <th className="border border-[#d9ddd5] bg-[#edf0e9] p-2" key={index} scope="col">{column}</th>)}</tr></thead><tbody>{visual.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td className="border border-[#d9ddd5] p-2" key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>}
      {(visual.kind === "steps" || visual.kind === "flow") && <ol className="space-y-2 text-sm">{visual.steps.map((step, index) => <li key={index}>{visual.kind === "flow" && index > 0 && <ArrowDown aria-hidden="true" className="my-2 text-[#1b6657]" size={16} />}<div className={visual.kind === "flow" ? "border border-[#d9ddd5] bg-[#f0f7f1] p-2" : ""}><span className="mr-2 font-semibold">{index + 1}.</span>{step}</div></li>)}</ol>}
    </figure>
  );
}

function Explanation({ reply }: { reply: TutorReply }) {
  return <><h4 className="font-semibold">{reply.concept_title}</h4><p className="mt-2 whitespace-pre-wrap">{reply.explanation}</p><p className="mt-3 font-semibold">Example</p><p className="mt-1 whitespace-pre-wrap">{reply.example}</p>{reply.visuals.map((visual, index) => <Visual key={index} visual={visual} />)}<p className="mt-3 font-medium text-[#1b6657]">{reply.check_question}</p></>;
}

export function AiTutor({ controller, lesson, nextTopicId, moduleReady }: {
  controller: ReturnType<typeof useTutor>;
  lesson?: { topic_id: string; title: string; description: string; moduleTitle: string; estimated_minutes: number };
  nextTopicId?: string;
  moduleReady: boolean;
}) {
  const { state, loading, busy, error, perform, reload } = controller;
  const [draft, setDraft] = useState("");
  const [pendingMessage, setPendingMessage] = useState("");
  const [mode, setMode] = useState<"chat" | "voice">("chat");
  const [capture, setCapture] = useState<"off" | "requesting" | "recording">("off");
  const [speaking, setSpeaking] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const conversationArea = useRef<HTMLDivElement>(null);
  const recognition = useRef<Recognition | null>(null);
  const lastSpoken = useRef("");
  const recognitionSupported = useSyncExternalStore(subscribe, hasRecognition, () => false);
  const speechSupported = useSyncExternalStore(subscribe, hasSpeech, () => false);
  const messages = state?.conversation.messages ?? [];
  const latestReply = messages.at(-1)?.reply;
  const paused = state?.paused ?? false;
  const completed = !!lesson && state?.topic_status[lesson.topic_id] === "completed";
  const disabled = loading || busy || !state || paused;

  useEffect(() => {
    const area = conversationArea.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [state?.active_topic_id, state?.conversation.messages]);

  useEffect(() => {
    return () => {
      recognition.current?.abort();
      recognition.current = null;
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, [lesson?.topic_id]);

  useEffect(() => {
    if (mode !== "voice" || !speechSupported || !latestReply || paused) return;
    const key = `${state?.active_topic_id}:${JSON.stringify(latestReply)}`;
    if (lastSpoken.current === key) return;
    lastSpoken.current = key;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(`${latestReply.explanation} ${latestReply.example} ${latestReply.check_question}`);
    utterance.lang = navigator.language;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => { setSpeaking(false); setVoiceError("Spoken output stopped or is unavailable. The lesson remains in chat."); };
    window.speechSynthesis.speak(utterance);
  }, [latestReply, mode, paused, speechSupported, state?.active_topic_id]);

  function stopAudio() {
    recognition.current?.abort();
    recognition.current = null;
    setCapture("off");
    if (speechSupported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }

  function toggleMicrophone() {
    if (recognition.current) { recognition.current.stop(); return; }
    const Constructor = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;
    if (!Constructor) { setVoiceError("Speech recognition is not supported in this browser. Use chat."); return; }
    stopAudio();
    setVoiceError("");
    const instance = new Constructor();
    recognition.current = instance;
    instance.lang = navigator.language;
    instance.continuous = false;
    instance.interimResults = false;
    instance.onstart = () => setCapture("recording");
    instance.onend = () => { if (recognition.current === instance) recognition.current = null; setCapture("off"); };
    instance.onerror = (event) => {
      setCapture("off");
      setVoiceError(event.error === "not-allowed" ? "Microphone permission was denied. Allow microphone access or use chat." : `Voice input failed (${event.error}). Use chat or try again.`);
    };
    instance.onresult = (event) => {
      if (recognition.current === instance) setDraft(event.results[0][0].transcript.slice(0, 2000));
    };
    setCapture("requesting");
    try { instance.start(); } catch { recognition.current = null; setCapture("off"); setVoiceError("The microphone could not start. Check permissions and use HTTPS or localhost."); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim() || disabled) return;
    stopAudio();
    setPendingMessage(draft.trim());
    const succeeded = await perform("message", undefined, draft);
    setPendingMessage("");
    if (succeeded) setDraft("");
  }

  async function act(action: Parameters<typeof perform>[0], topicId?: string) {
    stopAudio();
    if (await perform(action, topicId)) setDraft("");
  }

  return <section aria-labelledby="tutor-heading" className="flex min-w-0 flex-col border-t border-[#e0e2d9] bg-[#fbfcfa] lg:sticky lg:top-6 lg:h-[calc(100dvh-3rem)] lg:min-h-[36rem] lg:self-start lg:border-t-0">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#e0e2d9] px-5 py-4">
      <h2 className="text-base font-semibold" id="tutor-heading">AI Tutor</h2>
      <div className="flex items-center gap-2"><div aria-label="Tutor mode" className="inline-flex rounded-md border border-[#d9ddd5] p-1" role="group">{(["chat", "voice"] as const).map((choice) => <button aria-pressed={mode === choice} className={`rounded px-3 py-1 text-xs font-semibold ${mode === choice ? "bg-[#1b6657] text-white" : ""}`} key={choice} onClick={() => { stopAudio(); setMode(choice); }} type="button">{choice === "chat" ? "Chat" : "Voice"}</button>)}</div><button aria-label={paused ? "Resume lesson" : "Pause lesson"} className="rounded-md border border-[#d9ddd5] p-2 disabled:opacity-50" disabled={loading || busy || !state} onClick={() => void act(paused ? "resume" : "pause")} title={paused ? "Resume lesson" : "Pause lesson"} type="button">{paused ? <Play aria-hidden="true" size={16} /> : <Pause aria-hidden="true" size={16} />}</button></div>
    </header>
    <div aria-live="polite" className="max-h-40 shrink-0 overflow-auto border-b border-[#e0e2d9] px-5 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#68736d]">{paused ? "Paused" : "Active lesson"}</p>
      <h3 className="mt-1 break-words font-semibold">{lesson?.title ?? "No saved lesson available"}</h3>
      {lesson && <p className="mt-1 break-words text-xs text-[#68736d]">{lesson.moduleTitle} · {lesson.estimated_minutes} minutes</p>}
      {!!state?.conversation.concepts.length && <p className="mt-2 text-xs text-[#1b6657]">Concept {state.conversation.concept_index + 1} of {state.conversation.concepts.length}: {state.conversation.concepts[state.conversation.concept_index]}</p>}
    </div>
    <div aria-label="Tutor conversation" aria-live="polite" aria-relevant="additions" className="max-h-[32rem] min-h-48 flex-1 space-y-4 overflow-y-auto px-5 py-5 lg:max-h-none lg:min-h-0" ref={conversationArea} role="log">
      {loading && <p className="text-sm text-[#68736d]">Loading saved conversation and progress...</p>}
      {!loading && messages.length === 0 && <div className="py-5"><p className="font-semibold">Hi {state?.learner_name ?? "Learner"}! {lesson ? `Ready to learn ${lesson.title} from the basics?` : "Your tutor needs a saved syllabus."}</p><p className="mt-2 text-sm text-[#68736d]">Start when you are ready. Progress advances only when you confirm understanding.</p></div>}
      {messages.map((message, index) => <article className={message.role === "user" ? "ml-auto max-w-[90%] rounded-md border border-[#dce9df] bg-[#eaf4ef] p-3" : "min-w-0 border-b border-[#e0e2d9] pb-4 text-sm leading-6"} key={index}><p className="mb-2 text-xs font-semibold text-[#68736d]">{message.role === "user" ? "You" : "LearnOS Tutor"}</p><div className="break-words">{message.reply ? <Explanation reply={message.reply} /> : <p className="whitespace-pre-wrap text-sm">{message.text}</p>}</div></article>)}
      {pendingMessage && <article className="ml-auto max-w-[90%] rounded-md border border-[#dce9df] bg-[#eaf4ef] p-3"><p className="mb-2 text-xs font-semibold text-[#68736d]">You · Sending</p><p className="whitespace-pre-wrap break-words text-sm">{pendingMessage}</p></article>}
      {busy && <p className="text-sm text-[#68736d]" role="status">Tutor request in progress. Your saved progress is safe.</p>}
      {error && <p className="text-sm text-red-800" role="alert">{error}</p>}
      {voiceError && <p className="text-sm text-red-800" role="alert">{voiceError}</p>}
    </div>
    <div className="shrink-0 border-t border-[#e0e2d9] px-5 py-3">
      <div className="flex flex-wrap gap-2">
        {!completed && !state?.can_confirm && <button className="rounded-md bg-[#1b6657] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50" disabled={disabled} onClick={() => void act("start")} type="button"><Play aria-hidden="true" className="mr-1 inline" size={14} />{state?.conversation.concepts.length ? "Continue concept" : "Start lesson"}</button>}
        {state?.can_confirm && <button className="rounded-md bg-[#1b6657] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50" disabled={disabled} onClick={() => void act("confirm")} type="button"><Check aria-hidden="true" className="mr-1 inline" size={14} />I understand</button>}
        {!!messages.length && <><button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold disabled:opacity-50" disabled={disabled} onClick={() => void act("explain")} type="button">Explain again</button><button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold" onClick={() => input.current?.focus()} type="button">Ask a question</button><button aria-label="Repeat lesson" className="rounded-md border border-[#d9ddd5] p-2 disabled:opacity-50" disabled={disabled} onClick={() => void act("repeat")} title="Repeat lesson" type="button"><RotateCcw aria-hidden="true" size={14} /></button></>}
        {moduleReady && <button className="rounded-md border border-[#1b6657] px-3 py-2 text-xs font-semibold text-[#1b6657] disabled:opacity-50" disabled={disabled} onClick={() => void act("confirm_module")} type="button">Confirm module completion</button>}
        {completed && nextTopicId && !moduleReady && <button className="rounded-md border border-[#1b6657] px-3 py-2 text-xs font-semibold text-[#1b6657] disabled:opacity-50" disabled={disabled} onClick={() => void act("select", nextTopicId)} type="button">Next lesson</button>}
        {(error || state?.busy) && <button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold" onClick={() => void reload()} type="button">Reload saved state</button>}
      </div>
      {completed && <p className="mt-2 text-xs font-semibold text-[#1b6657]">Topic completed by your confirmation.</p>}
    </div>
    <form className="shrink-0 border-t border-[#e0e2d9] bg-white p-5" onSubmit={submit}>
      <label className="sr-only" htmlFor="tutor-message">Question about the active lesson</label>
      <textarea className="block w-full resize-none rounded-md border border-[#d9ddd5] p-3 text-sm outline-none focus:border-[#1b6657] disabled:bg-[#f6f8f5]" disabled={disabled || !lesson} id="tutor-message" maxLength={2000} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} placeholder={paused ? "Resume the lesson to continue" : "Ask about this concept..."} ref={input} rows={2} value={draft} />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">{mode === "voice" && <><button aria-label={capture === "off" ? "Start microphone" : "Stop microphone"} aria-pressed={capture !== "off"} className={`rounded-md border p-2 disabled:opacity-50 ${capture !== "off" ? "border-red-400 text-red-700" : "border-[#d9ddd5]"}`} disabled={!recognitionSupported || disabled} onClick={toggleMicrophone} title={capture === "off" ? "Start microphone" : "Stop microphone"} type="button">{capture === "off" ? <Mic aria-hidden="true" size={18} /> : <Square aria-hidden="true" size={18} />}</button><span className="text-xs text-[#68736d]">{capture === "recording" ? "Listening..." : capture === "requesting" ? "Requesting microphone..." : recognitionSupported ? "Voice input" : "Microphone unsupported"}</span></>}{speechSupported && <button aria-label={speaking ? "Stop spoken output" : "Read lesson aloud"} className="rounded-md border border-[#d9ddd5] p-2 disabled:opacity-50" disabled={!latestReply} onClick={() => { if (speaking) { stopAudio(); } else if (latestReply) { stopAudio(); const utterance = new SpeechSynthesisUtterance(`${latestReply.explanation} ${latestReply.example} ${latestReply.check_question}`); utterance.onstart = () => setSpeaking(true); utterance.onend = () => setSpeaking(false); utterance.onerror = () => setSpeaking(false); window.speechSynthesis.speak(utterance); } }} title={speaking ? "Stop spoken output" : "Read lesson aloud"} type="button">{speaking ? <VolumeX aria-hidden="true" size={18} /> : <Volume2 aria-hidden="true" size={18} />}</button>}</div>
        <button className="inline-flex items-center gap-2 rounded-md bg-[#1b6657] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={disabled || !draft.trim()} type="submit"><Send aria-hidden="true" size={16} />Send</button>
      </div>
      <p className="mt-2 text-xs text-[#68736d]">{mode === "voice" ? "Browser speech support varies; recognition may use your browser's speech service. Review the transcript before sending." : "Grounded in your saved syllabus. Understanding confirmation is not a mastery assessment."}</p>
    </form>
  </section>;
}