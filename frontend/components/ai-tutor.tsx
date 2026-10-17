"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ArrowDown, Check, Code2, Copy, LoaderCircle, Mic, Pause, Play, RotateCcw, Send, Square, Volume2, VolumeX } from "lucide-react";
import type { TutorReply, TutorState, TutorVisual, useTutor } from "@/lib/tutor";
import type { TutorRequestError } from "@/lib/tutor";
import { buildCodeLabPrompt, type CodeLabAction } from "@/lib/code-lab";
import { useLiveTutor } from "@/lib/tutor-live";

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

function formatConnectionTime(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ConversationMessage({ message }: { message: TutorState["conversation"]["messages"][number] }) {
  return <article className={message.role === "user" ? "ml-auto w-fit max-w-[88%] break-words rounded-3xl rounded-br-md bg-[#eaf4ef] px-4 py-3" : "mr-auto min-w-0 max-w-full break-words py-1"}>
    <p className="mb-2 text-xs font-semibold text-[#68736d]">{message.role === "user" ? "You" : "LearnOS Tutor"}{message.channel === "voice" ? " · Live voice" : ""}</p>
    <div className="min-w-0 break-words">{message.reply?.intent === "redirect" ? <p className="whitespace-pre-wrap text-sm leading-6 text-[#34423c]">{message.reply.redirect_message}</p> : message.reply ? <Explanation reply={message.reply} /> : <p className="whitespace-pre-wrap text-sm leading-6 text-[#34423c]">{message.text}</p>}</div>
  </article>;
}

function errorLayer(error: TutorRequestError) {
  const message = error.message.toLowerCase();
  if (error.code === "FIREBASE_TOKEN_UNAVAILABLE" || error.code?.startsWith("AUTHENTICATION_") || error.status === 401) {
    return "Firebase sign-in";
  }
  if (error.code === "TUTOR_TRANSPORT_ERROR" || error.code === "TUTOR_REQUEST_TIMEOUT" || message.includes("backend is unavailable")) {
    return "Frontend-to-backend connection";
  }
  if (error.status === 404 || error.status === 409 || message.includes("course") || message.includes("syllabus")) {
    return "Course or syllabus readiness";
  }
  if (message.includes("gemini") || message.includes("provider")) return "Gemini provider";
  return "Tutor service";
}

const suggestedQuestions = [
  "Can you explain this lesson more simply?",
  "Show me a practical example.",
  "What should I focus on in this topic?",
];

const codeLabActions: { action: CodeLabAction; label: string }[] = [
  { action: "generate", label: "Generate Code" },
  { action: "explain", label: "Explain Code" },
  { action: "debug", label: "Debug Code" },
  { action: "tests", label: "Generate Test Cases" },
];

export function AiTutor({ courseId, controller, courseTitle, lesson, nextTopicId, moduleReady, messageOnly = false }: {
  courseId: string;
  controller: ReturnType<typeof useTutor>;
  courseTitle: string;
  lesson?: { topic_id: string; title: string; description: string; moduleTitle: string; estimated_minutes: number };
  nextTopicId?: string;
  moduleReady: boolean;
  messageOnly?: boolean;
}) {
  const { state, loading, busy, error, perform, reload, acceptSavedState } = controller;
  const [draft, setDraft] = useState("");
  const [pendingMessage, setPendingMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<Parameters<typeof perform>[0] | null>(null);
  const [mode, setMode] = useState<"chat" | "browser" | "live">("chat");
  const [capture, setCapture] = useState<"off" | "requesting" | "recording">("off");
  const [speaking, setSpeaking] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [codeDraft, setCodeDraft] = useState("");
  const [codeLabBusy, setCodeLabBusy] = useState(false);
  const [codeLabError, setCodeLabError] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const conversationArea = useRef<HTMLDivElement>(null);
  const recognition = useRef<Recognition | null>(null);
  const intentionalRecognitionStop = useRef<Recognition | null>(null);
  const activeUtterance = useRef<SpeechSynthesisUtterance | null>(null);
  const lastSpoken = useRef("");
  const recognitionSupported = useSyncExternalStore(subscribe, hasRecognition, () => false);
  const speechSupported = useSyncExternalStore(subscribe, hasSpeech, () => false);
  const live = useLiveTutor(courseId, lesson?.topic_id ?? "", state?.progress_epoch ?? 0, acceptSavedState);
  const liveStatus = live.status;
  const disconnectLive = live.disconnect;
  const previousTopicId = useRef(lesson?.topic_id ?? "");
  const messages = state?.conversation.messages ?? [];
  const latestCodeLabRequest = messages.map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user" && message.text.startsWith("Code Lab · "))
    .at(-1);
  const latestCodeLabReply = latestCodeLabRequest
    ? messages.slice(latestCodeLabRequest.index + 1).find((message) => message.role === "assistant" && message.reply)?.reply ?? null
    : null;
  const latestCodeVisual = latestCodeLabReply?.visuals.find((visual) => visual.kind === "code");
  const latestReply = messages.at(-1)?.reply;
  const paused = state?.paused ?? false;
  const completed = !!lesson && state?.topic_status[lesson.topic_id] === "completed";
  const disabled = loading || busy || !state || paused;
  const errorSource = error ? errorLayer(error) : "";
  const liveConnected = live.status === "connected";
  const currentExchangeStart = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") return index > 0 && messages[index - 1].role === "user" ? index - 1 : index;
    }
    return 0;
  })();
  const currentConcept = state?.conversation.concepts[state.conversation.concept_index];
  const awaitingResponse = !!currentConcept && !state?.can_confirm
    && messages.some((message) => message.reply?.concept_title === currentConcept);

  useEffect(() => {
    const area = conversationArea.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [state?.active_topic_id, state?.conversation.messages, live.partialTranscript]);

  useEffect(() => {
    const topicId = lesson?.topic_id ?? "";
    if (previousTopicId.current === topicId) return;
    previousTopicId.current = topicId;
    if (liveStatus !== "idle") void disconnectLive();
  }, [lesson?.topic_id, disconnectLive, liveStatus]);

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
    if (mode !== "browser" || !speechSupported || !latestReply || paused) return;
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
    const message = draft.trim();
    if (!message || disabled) return;
    if (mode === "live") {
      if (live.sendText(message)) setDraft("");
      return;
    }
    stopAudio();
    setDraft("");
    setPendingMessage(message);
    const succeeded = await perform("message", undefined, message);
    setPendingMessage("");
    if (!succeeded) setDraft(message);
  }

  async function runCodeLab(action: CodeLabAction) {
    if (!lesson || disabled || codeLabBusy || liveConnected) return;
    setCodeLabBusy(true);
    setCodeLabError("");
    setCopyNotice("");
    try {
      const prompt = buildCodeLabPrompt(action, lesson.title, codeDraft);
      stopAudio();
      const label = codeLabActions.find((item) => item.action === action)?.label ?? "Code Lab";
      const requestMessage = `Code Lab · ${label}\n${prompt}`;
      if (requestMessage.length > 2000) {
        setCodeLabError("Shorten the code input to fit the tutor request limit.");
        return;
      }
      const succeeded = await perform("message", undefined, requestMessage);
      if (!succeeded) setCodeLabError("The tutor could not complete this Code Lab request. Review the tutor error and retry when ready.");
    } catch (failure) {
      setCodeLabError(failure instanceof Error ? failure.message : "Code Lab could not prepare this request.");
    } finally {
      setCodeLabBusy(false);
    }
  }

  async function copyGeneratedCode() {
    if (!latestCodeVisual) return;
    try {
      await navigator.clipboard.writeText(latestCodeVisual.code);
      setCopyNotice("Code copied.");
    } catch {
      setCopyNotice("Clipboard access is unavailable. Select and copy the code instead.");
    }
  }

  async function act(action: Parameters<typeof perform>[0], topicId?: string) {
    if (live.status !== "idle") await live.disconnect();
    stopAudio();
    setPendingAction(action);
    try {
      if (await perform(action, topicId)) setDraft("");
    } finally {
      setPendingAction(null);
    }
  }

  async function explainVisually() {
    if (live.status !== "idle") await live.disconnect();
    stopAudio();
    const message = "Please explain the current topic with a useful flow diagram or table if one would help.";
    setPendingMessage(message);
    await perform("message", undefined, message);
    setPendingMessage("");
  }

  return <section aria-labelledby="tutor-heading" className="flex min-w-0 max-w-full flex-col border-t border-[#e6ebe5] bg-[#f9fbf8] lg:sticky lg:top-4 lg:h-[calc(100dvh-2rem)] lg:min-h-[36rem] lg:self-start lg:border-l lg:border-t-0">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#e6ebe5] bg-white px-4 py-3.5 sm:px-5">
      <div className="min-w-0">
        <p className="text-[0.68rem] font-bold uppercase tracking-[0.12em] text-[#c35d42]">AI tutor</p>
        <h2 className="mt-0.5 text-base font-semibold tracking-tight text-[#19352d]" id="tutor-heading">AI Tutor</h2>
        <p className="mt-0.5 break-words text-xs leading-5 text-[#68736d]">{courseTitle}</p>
      </div>
      <div className="flex items-center gap-2"><div aria-label="Tutor mode" className="inline-flex rounded-md border border-[#d9ddd5] p-1" role="group">{(["chat", "browser", "live"] as const).map((choice) => <button aria-pressed={mode === choice} className={`rounded px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] ${mode === choice ? "bg-[#1b6657] text-white" : "text-[#586761] hover:bg-[#f0f7f1]"}`} key={choice} onClick={() => { if (live.status !== "idle") void live.disconnect(); stopAudio(); setVoiceError(""); setMode(choice); }} type="button">{choice === "chat" ? "Chat" : choice === "browser" ? "Browser voice" : "Live voice"}</button>)}</div>{!messageOnly && <button aria-label={paused ? "Resume lesson" : "Pause lesson"} className="rounded-md border border-[#d9ddd5] p-2 transition-colors hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:opacity-50" disabled={loading || busy || !state} onClick={() => void act(paused ? "resume" : "pause")} title={paused ? "Resume lesson" : "Pause lesson"} type="button">{paused ? <Play aria-hidden="true" size={16} /> : <Pause aria-hidden="true" size={16} />}</button>}</div>
    </header>
    <div aria-live="polite" className="max-h-32 shrink-0 overflow-auto border-b border-[#e6ebe5] bg-[#eef4ef] px-4 py-3 sm:px-5">
      <p className="text-[0.68rem] font-bold uppercase tracking-[0.1em] text-[#547066]">{paused ? "Lesson paused" : liveConnected ? "Live lesson" : "Active lesson"}</p>
      <h3 className="mt-1 break-words font-semibold text-[#19352d]">{lesson?.title ?? "No saved lesson available"}</h3>
      {lesson && <p className="mt-1 break-words text-xs text-[#68736d]">{lesson.moduleTitle} · {lesson.estimated_minutes} minutes</p>}
      {!!state?.conversation.concepts.length && <p className="mt-2 text-xs text-[#1b6657]">Concept {state.conversation.concept_index + 1} of {state.conversation.concepts.length}: {state.conversation.concepts[state.conversation.concept_index]}</p>}
      {liveConnected && <p className="mt-1 text-xs font-medium text-[#176b59]">Gemini Live session active</p>}
    </div>
    <div aria-label="Tutor conversation" aria-busy={busy} aria-live="polite" aria-relevant="additions" className="max-h-[32rem] min-h-48 min-w-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto px-4 py-4 sm:px-5 lg:max-h-none lg:min-h-0" ref={conversationArea} role="log">
      {loading && <p className="text-sm text-[#68736d]">Loading saved conversation and progress...</p>}
      {!loading && messages.length === 0 && <div className="border-l-2 border-[#d16a4c] py-1 pl-3">
        <p className="font-semibold text-[#19352d]">Hi {state?.learner_name ?? "Learner"}! {lesson ? `What would you like to understand about ${lesson.title}?` : "Your tutor needs a ready course syllabus."}</p>
        <p className="mt-1.5 max-w-prose text-sm leading-5 text-[#68736d]">Ask about this lesson. Chatting does not mark it complete; confirm when you understand the material.</p>
        {lesson && <div className="mt-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#68736d]">Suggested questions</p>
          <div className="flex flex-wrap gap-2">{suggestedQuestions.map((question) => <button className="rounded-md border border-[#d9ddd5] bg-white px-3 py-2 text-left text-xs font-medium text-[#34423c] transition hover:border-[#1b6657] hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} key={question} onClick={() => { setDraft(question); input.current?.focus(); }} type="button">{question}</button>)}</div>
        </div>}
      </div>}
      {currentExchangeStart > 0 && <details className="rounded-md border border-[#e0e2d9] bg-[#f6f8f5] p-3" key={`${courseId}-${lesson?.topic_id}`}><summary className="cursor-pointer text-xs font-semibold text-[#586761]">Earlier conversation ({currentExchangeStart} messages)</summary><div className="mt-3 space-y-4">{messages.slice(0, currentExchangeStart).map((message, index) => <ConversationMessage key={index} message={message} />)}</div></details>}
      {messages.slice(currentExchangeStart).map((message, index) => <ConversationMessage key={currentExchangeStart + index} message={message} />)}
      {pendingMessage && <article className="ml-auto max-w-[90%] rounded-md border border-[#dce9df] bg-[#eaf4ef] p-3"><p className="mb-2 text-xs font-semibold text-[#68736d]">You · Sending</p><p className="whitespace-pre-wrap break-words text-sm">{pendingMessage}</p></article>}
      {live.partialTranscript && <article className="max-w-full rounded-md border border-[#d9ddd5] bg-white/70 p-3"><p className="mb-2 text-xs font-semibold text-[#68736d]">Live transcript</p><p className="whitespace-pre-wrap break-words text-sm leading-6 text-[#34423c]">{live.partialTranscript}</p></article>}
      {busy && <p className="flex items-center gap-2 text-sm text-[#68736d]" role="status"><LoaderCircle aria-hidden="true" className="animate-spin" size={16} />Waiting for one tutor response. Your saved progress is safe.</p>}
      {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900" role="alert">
        <p className="font-semibold">{errorSource} issue</p>
        <p className="mt-1 break-words leading-6">{error.message}</p>
        {(error.status || error.code) && <p className="mt-2 text-xs text-red-800">{error.status ? `HTTP ${error.status}` : "No HTTP response"}{error.code ? ` · ${error.code}` : ""}</p>}
      </div>}
      {live.error && <p className="text-sm text-red-800" role="alert">{live.error}</p>}
      {live.hasUnsaved && <div className="flex flex-wrap items-center gap-2 text-xs text-[#586761]" role="status"><span>Some live transcript turns are still waiting to save.</span><button className="rounded-md border border-[#d9ddd5] px-2 py-1 font-semibold" onClick={() => void live.retrySave()} type="button">Retry saving transcript</button></div>}
      {awaitingResponse && !completed && <p className="mt-2 text-xs text-[#1b6657]" role="status">Your turn: answer the tutor’s question below. The tutor will wait before continuing.</p>}
      {voiceError && <p className="text-sm text-[#8b4e00]" role="status">{voiceError}</p>}
    </div>
    <div className="shrink-0 border-t border-[#e0e2d9] bg-[#fbfcfa] px-4 py-3 sm:px-5">
      {!messageOnly && paused && <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#eadfc8] bg-[#fbf8f1] p-3" role="status">
        <p className="text-sm leading-5 text-[#586761]">This lesson is paused. Resume it to continue concepts, ask questions, or request another explanation.</p>
        <button className="rounded-md bg-[#1b6657] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#145344] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:cursor-not-allowed disabled:opacity-50" disabled={loading || busy || !state} onClick={() => void act("resume")} type="button">{pendingAction === "resume" ? "Resuming…" : "Resume lesson"}</button>
      </div>}
      <div className="flex flex-wrap gap-2">
        {!messageOnly && !completed && !state?.can_confirm && <button className="rounded-md bg-[#1b6657] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#145344] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={() => void act("start")} type="button"><Play aria-hidden="true" className="mr-1 inline" size={14} />{pendingAction === "start" ? "Continuing…" : state?.conversation.concepts.length ? "Continue concept" : "Start lesson"}</button>}
        {!messageOnly && state?.can_confirm && <button className="rounded-md bg-[#1b6657] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#145344] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void act("confirm")} type="button"><Check aria-hidden="true" className="mr-1 inline" size={14} />{pendingAction === "confirm" ? "Saving…" : "I understand"}</button>}
        {!!messages.length && <>{!messageOnly && <><button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold transition hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={() => void act("explain")} type="button">{pendingAction === "explain" ? "Preparing explanation…" : "Explain again"}</button><button aria-label="Repeat lesson" className="rounded-md border border-[#d9ddd5] p-2 transition hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:opacity-50" disabled={disabled} onClick={() => void act("repeat")} title="Repeat lesson" type="button"><RotateCcw aria-hidden="true" size={14} /></button></>}<button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold transition hover:bg-[#f0f7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]" onClick={() => input.current?.focus()} type="button">Ask a question</button></>}
        {!messageOnly && moduleReady && <button className="rounded-md border border-[#1b6657] px-3 py-2 text-xs font-semibold text-[#1b6657] disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void act("confirm_module")} type="button">Confirm module completion</button>}
      {!messageOnly && completed && nextTopicId && !moduleReady && <button className="rounded-md border border-[#1b6657] px-3 py-2 text-xs font-semibold text-[#1b6657] disabled:opacity-50" disabled={disabled || liveConnected} onClick={() => void act("select", nextTopicId)} type="button">Next lesson</button>}
        {(error || state?.busy) && <button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold" onClick={() => void reload()} type="button">Reload saved state</button>}
        {!messageOnly && mode === "live" && lesson && <button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold" disabled={disabled || liveConnected} onClick={() => void explainVisually()} type="button">Explain visually</button>}
        {!messageOnly && <button className="rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold" disabled={disabled || liveConnected} onClick={() => { if (window.confirm("Restart this course from the beginning? Saved progress and tutor conversations will be reset.")) void act("restart"); }} type="button"><RotateCcw aria-hidden="true" className="mr-1 inline" size={13} />Restart course</button>}
      </div>
      {mode === "live" && <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[#e0e2d9] bg-[#f6f8f5] px-4 py-3 sm:px-5">
        {live.status === "idle" && <button className="rounded-md bg-[#1b6657] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={disabled || !lesson} onClick={() => void live.connect()} type="button"><Mic aria-hidden="true" className="mr-2 inline" size={16} />{live.error ? "Retry live session" : "Start live session"}</button>}
        {live.status === "connecting" && <div className="flex w-full flex-wrap items-center gap-3 text-sm text-[#586761]" role="status"><span>Connecting to Gemini Live and microphone… {formatConnectionTime(live.connectingSeconds)} / 1:00</span><button className="rounded-md border border-[#d9ddd5] px-2.5 py-1.5 text-xs font-semibold hover:bg-white" onClick={() => void live.disconnect(false)} type="button">Cancel</button></div>}
        {liveConnected && <><button aria-label={live.muted ? "Unmute microphone" : "Mute microphone"} className="rounded-md border border-[#d9ddd5] p-2" onClick={live.toggleMute} title={live.muted ? "Unmute microphone" : "Mute microphone"} type="button">{live.muted ? <Mic aria-hidden="true" size={18} /> : <Square aria-hidden="true" size={18} />}</button><span className="text-xs text-[#586761]">{live.muted ? "Microphone muted" : live.speaking ? "Tutor is speaking · interrupt anytime" : "Live · listening for your voice"}</span><button className="ml-auto rounded-md border border-[#d9ddd5] px-3 py-2 text-xs font-semibold" onClick={() => void live.disconnect()} type="button">Stop session</button></>}
        <p className="w-full text-xs text-[#68736d]">Live audio streams to Gemini. Text transcripts are saved with this course; raw audio is not stored.</p>
      </div>}
      {!messageOnly && <details className="mt-3 rounded-md border border-[#dce3db] bg-white">
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-semibold text-[#19352d] focus-visible:outline-2 focus-visible:outline-[#176b59]">
          <Code2 aria-hidden="true" className="text-[#176b59]" size={16} />
          Code Lab <span className="text-xs font-normal text-[#78847c]">Python · unverified</span>
        </summary>
        <div className="space-y-3 border-t border-[#e8ede8] p-3">
          <label className="block text-xs font-medium text-[#52645b]" htmlFor="code-lab-source">Code input <span className="font-normal text-[#78847c]">(required for explain, debug and tests)</span>
            <textarea className="mt-1.5 block w-full resize-y rounded-md border border-[#d6dfd8] px-3 py-2 font-mono text-xs leading-5 outline-none focus:border-[#176b59] focus:ring-2 focus:ring-[#176b59]/15" disabled={disabled || codeLabBusy} id="code-lab-source" maxLength={1400} onChange={(event) => setCodeDraft(event.target.value)} placeholder="Paste a short Python example..." rows={3} value={codeDraft} />
          </label>
          <div className="flex flex-wrap gap-2">
            {codeLabActions.map(({ action, label }) => <button className="min-h-9 rounded-md border border-[#cbd8d0] px-2.5 py-1.5 text-xs font-semibold text-[#176b59] transition hover:bg-[#f1f7f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176b59] disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled || codeLabBusy || !lesson} key={action} onClick={() => void runCodeLab(action)} type="button">{codeLabBusy ? "Working..." : label}</button>)}
          </div>
          <p className="text-[0.68rem] leading-4 text-[#78847c]">Uses this lesson and the existing tutor conversation. Generated code and tests are not executed or verified.</p>
          {codeLabError && <p className="text-xs text-red-800" role="alert">{codeLabError}</p>}
          {latestCodeLabReply && <section aria-label="Latest Code Lab response" className="rounded-md border border-[#dce3db] bg-[#f8faf7] p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-[0.65rem] font-bold uppercase tracking-wide text-[#68776e]">Tutor response · unverified</p>
                <h4 className="mt-1 text-sm font-semibold text-[#19352d]">{latestCodeLabReply.concept_title}</h4>
              </div>
              {latestCodeVisual && <button aria-label="Copy generated code" className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[#d6dfd8] px-2 text-xs font-semibold text-[#365c4e] hover:bg-white focus-visible:outline-2 focus-visible:outline-[#176b59]" onClick={() => void copyGeneratedCode()} type="button"><Copy aria-hidden="true" size={13} />Copy code</button>}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[#52645b]">{latestCodeLabReply.explanation}</p>
            {latestCodeVisual && <pre className="mt-3 max-h-64 overflow-auto rounded-md border border-[#30443b] bg-[#17251f] p-3 font-mono text-xs leading-5 text-[#f0f7f1]"><code>{latestCodeVisual.code}</code></pre>}
            <div className="mt-3 border-t border-[#e2e9e2] pt-2">
              <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-[#68776e]">Example / sample output</p>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-[#52645b]">{latestCodeLabReply.example}</p>
            </div>
            {copyNotice && <p className="mt-2 text-xs text-[#365c4e]" role="status">{copyNotice}</p>}
          </section>}
        </div>
      </details>}
      {completed && <p className="mt-2 text-xs font-semibold text-[#1b6657]">Topic completed by your confirmation.</p>}
    </div>
    <form className="shrink-0 border-t border-[#e0e2d9] bg-white p-5" onSubmit={submit}>
      <label className="sr-only" htmlFor="tutor-message">Question about the active lesson</label>
      <textarea className="block w-full resize-none rounded-md border border-[#d9ddd5] p-3 text-sm outline-none transition focus:border-[#1b6657] focus:ring-2 focus:ring-[#1b6657]/20 disabled:bg-[#f6f8f5]" disabled={disabled || !lesson || (mode === "live" && !liveConnected)} id="tutor-message" maxLength={2000} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} placeholder={mode === "live" ? liveConnected ? "Type a question or speak naturally…" : "Start a live lesson to use voice" : paused ? "Resume the lesson to continue" : "Ask about this concept..."} ref={input} rows={2} value={draft} />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">{mode === "browser" && <><button aria-label={capture === "off" ? "Start microphone" : "Stop microphone"} aria-pressed={capture !== "off"} className={`rounded-md border p-2 disabled:opacity-50 ${capture !== "off" ? "border-red-400 text-red-700" : "border-[#d9ddd5]"}`} disabled={!recognitionSupported || disabled} onClick={toggleMicrophone} title={capture === "off" ? "Start microphone" : "Stop microphone"} type="button">{capture === "off" ? <Mic aria-hidden="true" size={18} /> : <Square aria-hidden="true" size={18} />}</button><span className="text-xs text-[#68736d]">{capture === "recording" ? "Listening..." : capture === "requesting" ? "Requesting microphone..." : recognitionSupported ? "Voice input" : "Microphone unsupported"}</span></>}{speechSupported && mode !== "live" && <button aria-label={speaking ? "Stop spoken output" : "Read lesson aloud"} className="rounded-md border border-[#d9ddd5] p-2 disabled:opacity-50" disabled={!latestReply} onClick={() => { if (speaking) stopAudio(); else if (latestReply) speakReply(latestReply); }} title={speaking ? "Stop spoken output" : "Read lesson aloud"} type="button">{speaking ? <VolumeX aria-hidden="true" size={18} /> : <Volume2 aria-hidden="true" size={18} />}</button>}{mode === "browser" && (!recognitionSupported || !speechSupported) && <span className="text-xs text-[#68736d]" role="status">{!recognitionSupported && !speechSupported ? "Microphone and spoken output are unavailable in this browser. Chat remains available." : !recognitionSupported ? "Microphone input is unavailable in this browser. Chat remains available." : "Spoken output is unavailable in this browser. Chat remains available."}</span>}</div>
        <button className="inline-flex items-center gap-2 rounded-md bg-[#1b6657] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={disabled || !draft.trim() || (mode === "live" && !liveConnected)} type="submit"><Send aria-hidden="true" size={16} />{mode === "live" ? "Send live" : "Send"}</button>
      </div>
      <p className="mt-2 text-xs leading-5 text-[#68736d]">{mode === "browser" ? "Browser speech recognition and text-to-speech only; this is not Gemini Live. Microphone access starts only when you press the microphone. Review the transcript and press Send yourself." : mode === "live" ? "The tutor listens and responds in real time. You can interrupt, ask a doubt, or type while connected." : "Uses your saved syllabus and recent tutor history. Chatting does not mark a lesson complete."}</p>
    </form>
  </section>;
}
