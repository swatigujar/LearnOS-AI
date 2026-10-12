"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
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

export function AiTutor({ controller, lesson, nextTopicId, moduleReady }: {
  controller: ReturnType<typeof useTutor>;
  lesson?: { topic_id: string; title: string; description: string; moduleTitle: string; estimated_minutes: number };
  nextTopicId?: string;
  moduleReady: boolean;
}) {
  const { state, loading, busy, error, perform, reload } = controller;
  const [draft, setDraft] = useState("");
  const [pendingMessage, setPendingMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<Parameters<typeof perform>[0] | null>(null);
  const [mode, setMode] = useState<"chat" | "voice">("chat");
  const [capture, setCapture] = useState<"off" | "requesting" | "recording">("off");
  const [speaking, setSpeaking] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const conversationArea = useRef<HTMLDivElement>(null);
  const recognition = useRef<Recognition | null>(null);
  const intentionalRecognitionStop = useRef<Recognition | null>(null);
  const activeUtterance = useRef<SpeechSynthesisUtterance | null>(null);
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
      const instance = recognition.current;
      recognition.current = null;
      intentionalRecognitionStop.current = null;
      if (instance) {
        instance.onstart = null;
        instance.onend = null;
        instance.onerror = null;
        instance.onresult = null;
        instance.abort();
      }
      const utterance = activeUtterance.current;
      activeUtterance.current = null;
      if (utterance) {
        utterance.onstart = null;
        utterance.onend = null;
        utterance.onerror = null;
      }
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, [lesson?.topic_id]);

  const stopSpokenOutput = useCallback(() => {
    const utterance = activeUtterance.current;
    activeUtterance.current = null;
    if (utterance) {
      utterance.onstart = null;
      utterance.onend = null;
      utterance.onerror = null;
    }
    if (speechSupported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [speechSupported]);

  const speakReply = useCallback((reply: TutorReply) => {
    stopSpokenOutput();
    setVoiceError("");
    if (!speechSupported) {
      setVoiceError("Spoken output is not supported in this browser. Your lesson and conversation are still available in chat.");
      return;
    }

    try {
      const utterance = new SpeechSynthesisUtterance(`${reply.explanation} ${reply.example} ${reply.check_question}`);
      activeUtterance.current = utterance;
      utterance.lang = navigator.language;
      utterance.onstart = () => {
        if (activeUtterance.current === utterance) setSpeaking(true);
      };
      utterance.onend = () => {
        if (activeUtterance.current !== utterance) return;
        activeUtterance.current = null;
        setSpeaking(false);
      };
      utterance.onerror = () => {
        if (activeUtterance.current !== utterance) return;
        activeUtterance.current = null;
        setSpeaking(false);
        setVoiceError("Spoken output could not play. Your lesson and conversation are still available; you can retry or switch to chat.");
      };
      window.speechSynthesis.speak(utterance);
    } catch {
      activeUtterance.current = null;
      setSpeaking(false);
      setVoiceError("Spoken output could not start. Your lesson and conversation are still available; you can retry or switch to chat.");
    }
  }, [speechSupported, stopSpokenOutput]);

  useEffect(() => {
    if (mode !== "voice" || !speechSupported || !latestReply || paused) return;
    const key = `${state?.active_topic_id}:${JSON.stringify(latestReply)}`;
    if (lastSpoken.current === key) return;
    lastSpoken.current = key;
    speakReply(latestReply);
  }, [latestReply, mode, paused, speakReply, speechSupported, state?.active_topic_id]);

  function stopAudio() {
    const instance = recognition.current;
    recognition.current = null;
    intentionalRecognitionStop.current = null;
    if (instance) {
      instance.onstart = null;
      instance.onend = null;
      instance.onerror = null;
      instance.onresult = null;
      instance.abort();
    }
    setCapture("off");
    stopSpokenOutput();
  }

  function toggleMicrophone() {
    if (recognition.current) {
      intentionalRecognitionStop.current = recognition.current;
      recognition.current.stop();
      return;
    }
    const Constructor = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;
    if (!Constructor) { setVoiceError("Speech recognition is not supported in this browser. Use chat."); return; }
    stopAudio();
    setVoiceError("");
    const instance = new Constructor();
    recognition.current = instance;
    instance.lang = navigator.language;
    instance.continuous = false;
    instance.interimResults = false;
    instance.onstart = () => { if (recognition.current === instance) setCapture("recording"); };
    instance.onend = () => {
      if (recognition.current !== instance) return;
      recognition.current = null;
      intentionalRecognitionStop.current = null;
      setCapture("off");
    };
    instance.onerror = (event) => {
      if (recognition.current !== instance) return;
      const wasIntentionalStop = intentionalRecognitionStop.current === instance || event.error === "aborted";
      recognition.current = null;
      intentionalRecognitionStop.current = null;
      setCapture("off");
      if (wasIntentionalStop) return;
      setVoiceError(event.error === "not-allowed" ? "Microphone permission was denied. Allow microphone access or use chat." : `Voice input failed (${event.error}). Use chat or try again.`);
    };
    instance.onresult = (event) => {
      if (recognition.current === instance) setDraft(event.results[0][0].transcript.slice(0, 2000));
    };
    setCapture("requesting");
    try { instance.start(); } catch {
      if (recognition.current === instance) recognition.current = null;
      intentionalRecognitionStop.current = null;
      setCapture("off");
      setVoiceError("The microphone could not start. Check permissions and use HTTPS or localhost.");
    }
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
    setPendingAction(action);
    try {
      if (await perform(action, topicId)) setDraft("");
    } finally {
      setPendingAction(null);
    }
  }

  return <section aria-labelledby="tutor-heading" className="flex min-w-0 max-w-full flex-col border-t border-[#e0e2d9] bg-[#fbfcfa] lg:sticky lg:top-6 lg:h-[calc(100dvh-3rem)] lg:min-h-[36rem] lg:self-start lg:border-t-0">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#e0e2d9] bg-white px-4 py-4 sm:px-5">
      <h2 className="text-base font-semibold" id="tutor-heading">AI Tutor</h2>
      <div className="flex items-center gap-2"><div aria-label="Tutor mode" className="inline-flex rounded-md border border-[#d9ddd5] p-1" role="group">{(["chat", "voice"] as const).map((choice) => <button aria-pressed={mode === choice} className={`rounded px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] ${mode === choice ? "bg-[#1b6657] text-white" : "text-[#586761] hover:bg-[#f0f7f1]"}`} key={choice} onClick={() => { stopAudio(); setVoiceError(""); setMode(choice); }} type="button">{choice === "chat" ? "Chat" : "Voice"}</button>)}</div><button aria-label={paused ? "Resume lesson" : "Pause lesson"} className="rounded-md border border-[#d9ddd5] p-2 transition-colors hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:opacity-50" disabled={loading || busy || !state} onClick={() => void act(paused ? "resume" : "pause")} title={paused ? "Resume lesson" : "Pause lesson"} type="button">{paused ? <Play aria-hidden="true" size={16} /> : <Pause aria-hidden="true" size={16} />}</button></div>
    </header>
    <div aria-live="polite" className="max-h-40 shrink-0 overflow-auto border-b border-[#e0e2d9] bg-[#f6f8f5] px-4 py-3 sm:px-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#68736d]">{paused ? "Paused" : "Active lesson"}</p>
      <h3 className="mt-1 break-words font-semibold">{lesson?.title ?? "No saved lesson available"}</h3>
      {lesson && <p className="mt-1 break-words text-xs text-[#68736d]">{lesson.moduleTitle} · {lesson.estimated_minutes} minutes</p>}
      {!!state?.conversation.concepts.length && <p className="mt-2 text-xs text-[#1b6657]">Concept {state.conversation.concept_index + 1} of {state.conversation.concepts.length}: {state.conversation.concepts[state.conversation.concept_index]}</p>}
    </div>
    <div aria-label="Tutor conversation" aria-live="polite" aria-relevant="additions" className="max-h-[32rem] min-h-48 min-w-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-4 py-5 sm:px-5 lg:max-h-none lg:min-h-0" ref={conversationArea} role="log">
      {loading && <p className="text-sm text-[#68736d]">Loading saved conversation and progress...</p>}
      {!loading && messages.length === 0 && <div className="py-5"><p className="font-semibold">Hi {state?.learner_name ?? "Learner"}! {lesson ? `Ready to learn ${lesson.title} from the basics?` : "Your tutor needs a saved syllabus."}</p><p className="mt-2 text-sm text-[#68736d]">Start when ready. Confirm understanding to advance.</p></div>}
      {messages.map((message, index) => <article className={message.role === "user" ? "ml-auto max-w-[90%] break-words rounded-lg border border-[#dce9df] bg-[#eaf4ef] p-3 sm:p-4" : "min-w-0 max-w-full break-words rounded-lg border border-[#e0e2d9] bg-white p-3 shadow-sm sm:p-4"} key={index}><p className="mb-2 text-xs font-semibold text-[#68736d]">{message.role === "user" ? "You" : "LearnOS Tutor"}</p><div className="min-w-0 break-words">{message.reply ? <Explanation reply={message.reply} /> : <p className="whitespace-pre-wrap text-sm leading-6 text-[#34423c]">{message.text}</p>}</div></article>)}
      {pendingMessage && <article className="ml-auto max-w-[90%] rounded-md border border-[#dce9df] bg-[#eaf4ef] p-3"><p className="mb-2 text-xs font-semibold text-[#68736d]">You · Sending</p><p className="whitespace-pre-wrap break-words text-sm">{pendingMessage}</p></article>}
      {busy && <p className="text-sm text-[#68736d]" role="status">Tutor request in progress. Your saved progress is safe.</p>}
      {error && <p className="text-sm text-red-800" role="alert">{error}</p>}
      {voiceError && <p className="text-sm text-[#8b4e00]" role="status">{voiceError}</p>}
    </div>
    <div className="shrink-0 border-t border-[#e0e2d9] bg-[#fbfcfa] px-4 py-3 sm:px-5">
      {paused && <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#eadfc8] bg-[#fbf8f1] p-3" role="status">
        <p className="text-sm leading-5 text-[#586761]">This lesson is paused. Resume it to continue concepts, ask questions, or request another explanation.</p>
        <button className="rounded-md bg-[#1b6657] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#145344] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:cursor-not-allowed disabled:opacity-50" disabled={loading || busy || !state} onClick={() => void act("resume")} type="button">{pendingAction === "resume" ? "Resuming…" : "Resume lesson"}</button>
      </div>}
      <div className="flex flex-wrap gap-2">
        {!completed && !state?.can_confirm && <button className="rounded-md bg-[#1b6657] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#145344] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={() => void act("start")} type="button"><Play aria-hidden="true" className="mr-1 inline" size={14} />{pendingAction === "start" ? "Continuing…" : state?.conversation.concepts.length ? "Continue concept" : "Start lesson"}</button>}
        {state?.can_confirm && <button className="rounded-md bg-[#1b6657] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#145344] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:opacity-50" disabled={disabled} onClick={() => void act("confirm")} type="button"><Check aria-hidden="true" className="mr-1 inline" size={14} />{pendingAction === "confirm" ? "Saving…" : "I understand"}</button>}
        {!!messages.length && <><button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold transition hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={() => void act("explain")} type="button">{pendingAction === "explain" ? "Preparing explanation…" : "Explain again"}</button><button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold transition hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]" onClick={() => input.current?.focus()} type="button">Ask a question</button><button aria-label="Repeat lesson" className="rounded-md border border-[#d9ddd5] p-2 transition hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:opacity-50" disabled={disabled} onClick={() => void act("repeat")} title="Repeat lesson" type="button"><RotateCcw aria-hidden="true" size={14} /></button></>}
        {moduleReady && <button className="rounded-md border border-[#1b6657] px-3 py-2 text-xs font-semibold text-[#1b6657] disabled:opacity-50" disabled={disabled} onClick={() => void act("confirm_module")} type="button">Confirm module completion</button>}
        {completed && nextTopicId && !moduleReady && <button className="rounded-md border border-[#1b6657] px-3 py-2 text-xs font-semibold text-[#1b6657] disabled:opacity-50" disabled={disabled} onClick={() => void act("select", nextTopicId)} type="button">Next lesson</button>}
        {(error || state?.busy) && <button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold" onClick={() => void reload()} type="button">Reload saved state</button>}
      </div>
      {completed && <p className="mt-2 text-xs font-semibold text-[#1b6657]">Topic completed by your confirmation.</p>}
    </div>
    <form className="shrink-0 border-t border-[#e0e2d9] bg-white p-5" onSubmit={submit}>
      <label className="sr-only" htmlFor="tutor-message">Question about the active lesson</label>
      <textarea className="block w-full resize-none rounded-md border border-[#d9ddd5] p-3 text-sm outline-none transition focus:border-[#1b6657] focus:ring-2 focus:ring-[#1b6657]/20 disabled:bg-[#f6f8f5]" disabled={disabled || !lesson} id="tutor-message" maxLength={2000} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} placeholder={paused ? "Resume the lesson to continue" : "Ask about this concept..."} ref={input} rows={2} value={draft} />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">{mode === "voice" && <><button aria-label={capture === "off" ? "Start microphone" : "Stop microphone"} aria-pressed={capture !== "off"} className={`rounded-md border p-2 disabled:opacity-50 ${capture !== "off" ? "border-red-400 text-red-700" : "border-[#d9ddd5]"}`} disabled={!recognitionSupported || disabled} onClick={toggleMicrophone} title={capture === "off" ? "Start microphone" : "Stop microphone"} type="button">{capture === "off" ? <Mic aria-hidden="true" size={18} /> : <Square aria-hidden="true" size={18} />}</button><span className="text-xs text-[#68736d]">{capture === "recording" ? "Listening..." : capture === "requesting" ? "Requesting microphone..." : recognitionSupported ? "Voice input" : "Microphone unsupported"}</span></>}{speechSupported && <button aria-label={speaking ? "Stop spoken output" : "Read lesson aloud"} className="rounded-md border border-[#d9ddd5] p-2 disabled:opacity-50" disabled={!latestReply} onClick={() => { if (speaking) stopAudio(); else if (latestReply) speakReply(latestReply); }} title={speaking ? "Stop spoken output" : "Read lesson aloud"} type="button">{speaking ? <VolumeX aria-hidden="true" size={18} /> : <Volume2 aria-hidden="true" size={18} />}</button>}{mode === "voice" && (!recognitionSupported || !speechSupported) && <span className="text-xs text-[#68736d]" role="status">{!recognitionSupported && !speechSupported ? "Microphone and spoken output are unavailable in this browser. Chat remains available." : !recognitionSupported ? "Microphone input is unavailable in this browser. Chat remains available." : "Spoken output is unavailable in this browser. Chat remains available."}</span>}</div>
        <button className="inline-flex items-center gap-2 rounded-md bg-[#1b6657] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={disabled || !draft.trim()} type="submit"><Send aria-hidden="true" size={16} />Send</button>
      </div>
      <p className="mt-2 text-xs text-[#68736d]">{mode === "voice" ? "Browser speech support varies; recognition may use your browser's speech service. Review the transcript before sending." : "Grounded in your saved syllabus. Understanding confirmation is not a mastery assessment."}</p>
    </form>
  </section>;
}
