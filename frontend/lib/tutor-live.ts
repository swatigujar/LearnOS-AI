"use client";

import { GoogleGenAI, Modality, type LiveConnectConfig, type LiveServerMessage, type Session } from "@google/genai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { friendlyTutorError, friendlyTutorFailure, type TutorState } from "@/lib/tutor";

type LiveStatus = "idle" | "connecting" | "connected";
type LiveTurn = { role: "user" | "assistant"; text: string };
type LiveUsageDetail = { modality: string; token_count: number };
type LiveUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  total_tokens: number | null;
  prompt_tokens_details: LiveUsageDetail[];
  response_tokens_details: LiveUsageDetail[];
};
type PendingSave = {
  operationId: string;
  courseId: string;
  topicId: string;
  progressEpoch: number;
  getIdToken: () => Promise<string>;
  turns: LiveTurn[];
  usage: LiveUsage | null;
};
type LiveSessionResponse = { accessToken: string; model: string; config: LiveConnectConfig };
const LIVE_CONNECT_TIMEOUT_MS = 60_000;

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, onLateValue?: (value: T) => void) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      settled = true;
      const failure = new Error("Live tutor connection timed out.");
      failure.name = "TimeoutError";
      reject(failure);
    }, Math.max(1, timeoutMs));
    operation.then((value) => {
      if (settled) {
        onLateValue?.(value);
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    }, (failure: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      reject(failure);
    });
  });
}

const workletSource = `
class LearnOsPcmProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.pending = []; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    const ratio = sampleRate / 16000;
    for (let index = 0; index < channel.length; index += ratio) {
      const start = Math.floor(index);
      const fraction = index - start;
      const next = Math.min(start + 1, channel.length - 1);
      this.pending.push(channel[start] * (1 - fraction) + channel[next] * fraction);
    }
    while (this.pending.length >= 320) {
      const samples = this.pending.splice(0, 320);
      const pcm = new Int16Array(320);
      for (let index = 0; index < samples.length; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index]));
        pcm[index] = value < 0 ? value * 32768 : value * 32767;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor("learnos-pcm-processor", LearnOsPcmProcessor);
`;

export function useLiveTutor(
  courseId: string,
  topicId: string,
  progressEpoch: number,
  onSavedState: (state: TutorState) => void,
) {
  const { user } = useAuth();
  const activeTargetRef = useRef({ courseId, topicId });
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [connectingSince, setConnectingSince] = useState<number | null>(null);
  const [connectingSeconds, setConnectingSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const [error, setError] = useState("");
  const sessionRef = useRef<Session | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const microphoneContextRef = useRef<AudioContext | null>(null);
  const microphoneNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const playbackTimeRef = useRef(0);
  const mutedRef = useRef(false);
  const inputTranscriptRef = useRef("");
  const usageRef = useRef<LiveUsage | null>(null);
  const typedInputRef = useRef<string[]>([]);
  const outputTranscriptRef = useRef("");
  const saveQueueRef = useRef<PendingSave[]>([]);
  const transcriptFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const savingPromiseRef = useRef<Promise<void> | null>(null);
  const activeRef = useRef(false);
  const connectionGenerationRef = useRef(0);
  const onSavedStateRef = useRef(onSavedState);

  useEffect(() => {
    activeTargetRef.current = { courseId, topicId };
    onSavedStateRef.current = onSavedState;
  }, [courseId, onSavedState, topicId]);

  useEffect(() => {
    if (connectingSince === null) return;
    const updateElapsed = () => setConnectingSeconds(Math.floor((Date.now() - connectingSince) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [connectingSince]);

  const savePendingTranscripts = useCallback(async () => {
    if (!saveQueueRef.current.length) return;
    if (savingRef.current) {
      await savingPromiseRef.current;
      return;
    }
    savingRef.current = true;
    const saving = (async () => {
      await Promise.resolve();
      try {
        while (saveQueueRef.current.length) {
          const pending = saveQueueRef.current[0];
          const token = await pending.getIdToken();
          const response = await fetch("/api/tutor/live/transcript", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              courseId: pending.courseId,
              topicId: pending.topicId,
              progressEpoch: pending.progressEpoch,
              operationId: pending.operationId,
              turns: pending.turns,
              ...(pending.usage ? { usage: pending.usage } : {}),
            }),
            cache: "no-store",
            keepalive: true,
            signal: AbortSignal.timeout(25_000),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(friendlyTutorError(response.status, result.detail));
          saveQueueRef.current.shift();
          if (activeRef.current) setHasUnsaved(saveQueueRef.current.length > 0);
          const target = activeTargetRef.current;
          if (activeRef.current && pending.courseId === target.courseId && pending.topicId === target.topicId) {
            onSavedStateRef.current(result as TutorState);
          }
        }
        if (activeRef.current) setError("");
      } catch (failure) {
        const failed = saveQueueRef.current[0];
        const target = activeTargetRef.current;
        if (activeRef.current && failed?.courseId === target.courseId && failed.topicId === target.topicId) {
          setError(friendlyTutorFailure(failure));
        }
      } finally {
        savingRef.current = false;
      }
    })();
    savingPromiseRef.current = saving;
    await saving;
    if (savingPromiseRef.current === saving) savingPromiseRef.current = null;
  }, []);

  const enqueueTranscript = useCallback((turns: LiveTurn[], usage: LiveUsage | null) => {
    if (!user || !turns.length) return;
    saveQueueRef.current.push({
      operationId: crypto.randomUUID(),
      courseId,
      topicId,
      progressEpoch,
      getIdToken: () => user.getIdToken(),
      turns,
      usage,
    });
    if (activeRef.current) {
      setPartialTranscript("");
      setHasUnsaved(true);
    }
  }, [courseId, progressEpoch, topicId, user]);

  const queueCurrentTurn = useCallback(() => {
    const learnerText = [typedInputRef.current.join(" "), inputTranscriptRef.current]
      .filter(Boolean).join(" ").trim();
    const tutorText = outputTranscriptRef.current.trim();
    const turns: LiveTurn[] = [];
    if (learnerText) turns.push({ role: "user", text: learnerText.slice(0, 2000) });
    if (tutorText) turns.push({ role: "assistant", text: tutorText.slice(0, 2000) });
    const usage = usageRef.current;
    typedInputRef.current = [];
    inputTranscriptRef.current = "";
    outputTranscriptRef.current = "";
    usageRef.current = null;
    enqueueTranscript(turns, usage);
  }, [enqueueTranscript]);

  const stopPlayback = useCallback(() => {
    for (const source of playbackSourcesRef.current) {
      try { source.stop(); } catch { /* The source may already have ended. */ }
      source.disconnect();
    }
    playbackSourcesRef.current.clear();
    const context = playbackContextRef.current;
    playbackTimeRef.current = context?.currentTime ?? 0;
    setSpeaking(false);
  }, []);

  const playAudioChunk = useCallback((encoded: string) => {
    const context = playbackContextRef.current;
    if (!context) return;
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const pcm = new Int16Array(bytes.buffer);
    const audio = context.createBuffer(1, pcm.length, 24000);
    const samples = audio.getChannelData(0);
    for (let index = 0; index < pcm.length; index += 1) samples[index] = pcm[index] / 32768;
    const source = context.createBufferSource();
    source.buffer = audio;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, playbackTimeRef.current);
    source.start(startAt);
    playbackTimeRef.current = startAt + audio.duration;
    playbackSourcesRef.current.add(source);
    source.onended = () => {
      playbackSourcesRef.current.delete(source);
      source.disconnect();
      if (playbackSourcesRef.current.size === 0) setSpeaking(false);
    };
    setSpeaking(true);
  }, []);

  const handleMessage = useCallback((message: LiveServerMessage) => {
    if (!activeRef.current) return;
    if (message.usageMetadata) {
      const details = (items: typeof message.usageMetadata.promptTokensDetails) => (items ?? [])
        .flatMap((item) => typeof item.modality === "string" && Number.isInteger(item.tokenCount) && item.tokenCount! >= 0
          ? [{ modality: item.modality, token_count: item.tokenCount! }]
          : []);
      const metadata = message.usageMetadata;
      usageRef.current = {
        input_tokens: metadata.promptTokenCount ?? null,
        output_tokens: metadata.responseTokenCount ?? null,
        thinking_tokens: metadata.thoughtsTokenCount ?? null,
        total_tokens: metadata.totalTokenCount ?? null,
        prompt_tokens_details: details(metadata.promptTokensDetails),
        response_tokens_details: details(metadata.responseTokensDetails),
      };
    }
    const content = message.serverContent;
    if (!content) return;
    if (content.interrupted) {
      stopPlayback();
      const interruptedTutorText = outputTranscriptRef.current.trim();
      if (interruptedTutorText) {
        const usage = usageRef.current;
        usageRef.current = null;
        enqueueTranscript([{ role: "assistant", text: interruptedTutorText.slice(0, 2000) }], usage);
        void savePendingTranscripts();
      }
      outputTranscriptRef.current = "";
      setPartialTranscript([typedInputRef.current.join(" "), inputTranscriptRef.current].filter(Boolean).join("\n"));
    }
    if (content.inputTranscription?.text) {
      inputTranscriptRef.current += content.inputTranscription.text;
    }
    if (content.outputTranscription?.text) {
      outputTranscriptRef.current += content.outputTranscription.text;
    }
    const partial = [typedInputRef.current.join(" ") || inputTranscriptRef.current, outputTranscriptRef.current]
      .filter(Boolean).join("\n");
    if (partial) setPartialTranscript(partial);
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) playAudioChunk(part.inlineData.data);
    }
    if (content.turnComplete) {
      if (playbackSourcesRef.current.size === 0) setSpeaking(false);
      if (transcriptFlushRef.current) clearTimeout(transcriptFlushRef.current);
      transcriptFlushRef.current = setTimeout(() => {
        transcriptFlushRef.current = null;
        queueCurrentTurn();
        void savePendingTranscripts();
      }, 300);
    }
  }, [enqueueTranscript, playAudioChunk, queueCurrentTurn, savePendingTranscripts, stopPlayback]);

  const disconnect = useCallback(async (saveTranscript = true) => {
    connectionGenerationRef.current += 1;
    if (transcriptFlushRef.current) {
      clearTimeout(transcriptFlushRef.current);
      transcriptFlushRef.current = null;
    }
    if (saveTranscript) queueCurrentTurn();
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) session.close();
    setStatus("idle");
    setMuted(false);
    setSpeaking(false);
    setPartialTranscript("");
    microphoneNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    microphoneNodeRef.current = null;
    sourceNodeRef.current = null;
    microphoneRef.current?.getTracks().forEach((track) => track.stop());
    microphoneRef.current = null;
    const capture = microphoneContextRef.current;
    microphoneContextRef.current = null;
    if (capture && capture.state !== "closed") await capture.close().catch(() => undefined);
    const playback = playbackContextRef.current;
    playbackContextRef.current = null;
    if (playback && playback.state !== "closed") await playback.close().catch(() => undefined);
    playbackSourcesRef.current.clear();
    setConnectingSince(null);
    if (saveTranscript) await savePendingTranscripts();
  }, [queueCurrentTurn, savePendingTranscripts]);

  const connect = useCallback(async () => {
    if (!user || !topicId || status !== "idle") return false;
    const generation = ++connectionGenerationRef.current;
    const deadline = Date.now() + LIVE_CONNECT_TIMEOUT_MS;
    const remainingTime = () => Math.max(1, deadline - Date.now());
    const isCurrent = () => activeRef.current && connectionGenerationRef.current === generation;
    activeRef.current = true;
    setStatus("connecting");
    setConnectingSeconds(0);
    setConnectingSince(Date.now());
    setError("");
    if (saveQueueRef.current.length) void savePendingTranscripts();
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
        throw new Error("Live voice needs a supported browser and microphone. You can continue in chat.");
      }
      const microphone = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: true }),
        Math.min(30_000, remainingTime()),
        (lateMicrophone) => lateMicrophone.getTracks().forEach((track) => track.stop()),
      );
      if (!isCurrent()) {
        microphone.getTracks().forEach((track) => track.stop());
        return false;
      }
      microphoneRef.current = microphone;
      const capture = new AudioContext({ sampleRate: 16000 });
      microphoneContextRef.current = capture;
      const workletUrl = URL.createObjectURL(new Blob([workletSource], { type: "application/javascript" }));
      try { await withTimeout(capture.audioWorklet.addModule(workletUrl), remainingTime()); }
      finally { URL.revokeObjectURL(workletUrl); }
      if (!isCurrent()) return false;
      const source = capture.createMediaStreamSource(microphone);
      const processor = new AudioWorkletNode(capture, "learnos-pcm-processor");
      const silentGain = capture.createGain();
      silentGain.gain.value = 0;
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(capture.destination);
      sourceNodeRef.current = source;
      microphoneNodeRef.current = processor;
      processor.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const session = sessionRef.current;
        if (!session || mutedRef.current) return;
        session.sendRealtimeInput({
          audio: { data: toBase64(event.data), mimeType: "audio/pcm;rate=16000" },
        });
      };
      const playback = new AudioContext({ sampleRate: 24000 });
      playbackContextRef.current = playback;
      await withTimeout(Promise.all([capture.resume(), playback.resume()]), remainingTime());
      if (!isCurrent()) return false;

      const idToken = await user.getIdToken();
      if (!isCurrent()) return false;
      const tokenResponse = await fetch("/api/tutor/live/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ courseId, topicId }),
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(25_000, remainingTime())),
      });
      if (!isCurrent()) return false;
      const tokenResult = await tokenResponse.json();
      if (!isCurrent()) return false;
      if (!tokenResponse.ok) throw new Error(friendlyTutorError(tokenResponse.status, tokenResult.detail));
      const details = tokenResult as LiveSessionResponse;
      const ai = new GoogleGenAI({ apiKey: details.accessToken });
      let connectedSession: Session | null = null;
      let connectionReady = false;
      const isConnectedSession = () => connectionReady && sessionRef.current === connectedSession;
      let rejectPendingConnection: (failure: Error) => void = () => {};
      const connectionFailure = new Promise<never>((_, reject) => {
        rejectPendingConnection = reject;
      });
      const session = await withTimeout(Promise.race([ai.live.connect({
        model: details.model,
        config: { ...details.config, responseModalities: [Modality.AUDIO] },
        callbacks: {
          onmessage: (message) => {
            if (isConnectedSession()) handleMessage(message);
          },
          onerror: (event) => {
            if (!connectionReady && activeRef.current) rejectPendingConnection(new Error(event.message));
            else if (isConnectedSession() && activeRef.current) setError(friendlyTutorFailure(new Error(event.message)));
          },
          onclose: () => {
            if (!isConnectedSession()) return;
            sessionRef.current = null;
            void disconnect(true);
          },
        },
      }), connectionFailure]), remainingTime(), (lateSession) => lateSession.close());
      if (!isCurrent()) {
        session.close();
        return false;
      }
      sessionRef.current = session;
      connectedSession = session;
      connectionReady = true;
      rejectPendingConnection(new Error("Live connection established."));
      mutedRef.current = false;
      setMuted(false);
      setStatus("connected");
      setConnectingSince(null);
      session.sendRealtimeInput({ text: "Begin or continue this lesson from my saved course progress. Teach one small idea and ask me one question." });
      return true;
    } catch (failure) {
      if (!isCurrent()) return false;
      await disconnect(false);
      if (!activeRef.current) return false;
      setStatus("idle");
      setError(friendlyTutorFailure(failure));
      return false;
    }
  }, [courseId, disconnect, handleMessage, savePendingTranscripts, status, topicId, user]);

  const sendText = useCallback((text: string) => {
    const session = sessionRef.current;
    const cleaned = text.trim();
    if (!session || !cleaned) return false;
    typedInputRef.current.push(cleaned);
    session.sendRealtimeInput({ text: cleaned });
    setPartialTranscript(typedInputRef.current.join("\n"));
    return true;
  }, []);

  const toggleMute = useCallback(() => {
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
    microphoneRef.current?.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
    if (nextMuted) sessionRef.current?.sendRealtimeInput({ audioStreamEnd: true });
    setMuted(nextMuted);
  }, []);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      void disconnect(true);
    };
  }, [disconnect]);

  return {
    status, connectingSeconds, muted, speaking, partialTranscript, error, hasUnsaved,
    connect, disconnect, sendText, toggleMute, retrySave: savePendingTranscripts,
  };
}
