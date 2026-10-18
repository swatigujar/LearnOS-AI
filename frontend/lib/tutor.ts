"use client";

import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { useAuth } from "@/lib/auth-context";
import { mergeTutorMessages } from "@/lib/tutor-history";

export type TutorVisual = {
  kind: "code" | "table" | "steps" | "flow";
  title: string;
  code: string;
  columns: string[];
  rows: string[][];
  steps: string[];
};
export type TutorReply = {
  intent: "teach" | "redirect";
  redirect_message: string;
  concepts: string[];
  concept_title: string;
  explanation: string;
  example: string;
  check_question: string;
  visuals: TutorVisual[];
};
export type TutorState = {
  learner_name: string;
  active_topic_id: string;
  syllabus_version: number;
  progress_epoch: number;
  revision: number;
  paused: boolean;
  busy: boolean;
  pending_operation_id?: string | null;
  topic_status: Record<string, "not_started" | "in_progress" | "completed">;
  module_status: Record<string, "not_started" | "in_progress" | "completed">;
  conversation: {
    concepts: string[];
    concept_index: number;
    taught_index: number | null;
    answered_index: number | null;
    messages: { id?: string | null; role: "user" | "assistant"; text: string; reply: TutorReply | null; channel: "chat" | "voice" }[];
  };
  can_confirm: boolean;
};
export type TutorAction = "start" | "message" | "explain" | "confirm" | "confirm_module" | "pause" | "resume" | "select" | "repeat" | "restart";

export function friendlyTutorError(status: number, detail = "") {
  if (status === 429) return "Your tutor needs a short break. Your saved progress is still here. Please come back and try again later.";
  if (status === 503) return "We're having a little trouble connecting to your tutor. Your saved progress is still here. Please try again in a moment.";
  if (status === 504) return "Your tutor needs a little more time to reply. Your saved progress is still here. Please try again in a moment.";
  if (status === 401) return "Your sign-in needs refreshing. Please sign in again to continue your lesson.";
  if (status === 404) return "This course is no longer available. Return to your courses and choose another lesson.";
  if (status === 409 && detail.toLowerCase().includes("paused")) return "This lesson is paused. Resume it from Lesson controls to continue.";
  if (status === 409 && detail.toLowerCase().includes("earlier course progress")) return "This voice session ended after the course restarted. Start a new session to continue.";
  if (status === 409) return "Your lesson changed while we were talking. Reload the saved lesson, then try again.";
  if (status === 422) return "I couldn't process that request. Please try rephrasing it.";
  return "We couldn't finish that step just now. Your saved progress is still here. Please try again in a moment.";
}

export function friendlyTutorFailure(failure: unknown) {
  const detail = failure instanceof Error ? failure.message : "";
  const normalized = detail.toLowerCase();
  const errorName = failure instanceof Error ? failure.name.toLowerCase() : "";
  if (failure instanceof Error && failure.name === "TimeoutError" || /timed out|deadline/.test(normalized)) {
    return "Live voice couldn't connect in time. Check microphone access or your network, then try again or continue in chat.";
  }
  if (/\b429\b|quota|rate.?limit|request limit/.test(normalized)) return friendlyTutorError(429);
  if (/notallowed|securityerror/.test(errorName) || /notallowed|microphone permission|microphone access/.test(normalized)) {
    return "Microphone access is off. Allow it in your browser settings, or continue in chat.";
  }
  if (detail.startsWith("Live voice needs a supported browser")) return detail;
  if (/network|fetch|temporarily unavailable/.test(normalized)) return friendlyTutorError(503);
  return friendlyTutorError(502);
}

async function requestTutor<T = TutorState>(user: User, courseId: string, body?: object,
  options: { signal?: AbortSignal; query?: string } = {}): Promise<T> {
  let token: string;
  try { token = await user.getIdToken(); }
  catch { throw new Error(friendlyTutorError(401)); }
  let response: Response;
  try {
    response = await fetch(`/api/tutor?courseId=${encodeURIComponent(courseId)}${options.query ?? ""}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(body ? 155_000 : 20_000)])
        : AbortSignal.timeout(body ? 155_000 : 20_000),
    });
  } catch (failure) {
    if (options.signal?.aborted) throw failure;
    throw new Error(failure instanceof Error && failure.name === "TimeoutError"
      ? friendlyTutorError(504)
      : friendlyTutorError(503));
  }
  let result: { detail?: string; message?: string };
  try { result = await response.json(); }
  catch { throw new Error(friendlyTutorError(502)); }
  if (!response.ok) throw new Error(friendlyTutorError(response.status, result.detail ?? result.message ?? ""));
  return result as T;
}

export function useTutor(courseId: string, enabled: boolean) {
  const { user } = useAuth();
  const [state, setState] = useState<TutorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [history, setHistory] = useState<{
    topicId: string; epoch: number; messages: TutorState["conversation"]["messages"]; cursor: string | null; loaded: boolean;
  } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFailure, setHistoryFailure] = useState<{ topicId: string; epoch: number; message: string } | null>(null);
  const stateRef = useRef<TutorState | null>(null);
  const inFlight = useRef(false);
  const activeRequest = useRef<{ id: string; controller: AbortController } | null>(null);
  const stopInFlight = useRef(false);
  const historyInFlight = useRef(false);
  const historyGeneration = useRef(0);

  function saveState(saved: TutorState) {
    stateRef.current = saved;
    setState(saved);
    setHistory((current) => {
      if (!current || current.topicId !== saved.active_topic_id || current.epoch !== saved.progress_epoch) {
        return { topicId: saved.active_topic_id, epoch: saved.progress_epoch,
          messages: saved.conversation.messages, cursor: null, loaded: false };
      }
      return { ...current, messages: mergeTutorMessages(current.messages, saved.conversation.messages) };
    });
  }

  useEffect(() => {
    if (!user || !enabled) return;
    let active = true;
    requestTutor(user, courseId)
      .then((saved) => { if (active) { stateRef.current = saved; setState(saved); setError(""); } })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Unable to load tutor progress."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [courseId, enabled, user]);

  const activeTopic = state?.active_topic_id;
  const progressEpoch = state?.progress_epoch;
  const historyError = historyFailure?.topicId === activeTopic && historyFailure?.epoch === progressEpoch
    ? historyFailure?.message ?? "" : "";
  useEffect(() => {
    if (!user || !enabled || !activeTopic || progressEpoch === undefined) return;
    const generation = ++historyGeneration.current;
    historyInFlight.current = true;
    requestTutor<{ messages: TutorState["conversation"]["messages"]; next_cursor: string | null }>(
      user, courseId, undefined, { query: `&view=history&topicId=${encodeURIComponent(activeTopic)}` },
    ).then((page) => {
      if (generation === historyGeneration.current) {
        setHistoryFailure(null);
        setHistory((current) => ({
          topicId: activeTopic, epoch: progressEpoch,
          messages: mergeTutorMessages(page.messages,
            current?.topicId === activeTopic && current.epoch === progressEpoch ? current.messages :
              stateRef.current?.active_topic_id === activeTopic ? stateRef.current.conversation.messages : []),
          cursor: page.next_cursor, loaded: true,
        }));
      }
    }).catch(() => {
      if (generation === historyGeneration.current) setHistoryFailure({
        topicId: activeTopic, epoch: progressEpoch,
        message: "We couldn't load older messages just now. Your saved chat is still there. Please try again.",
      });
    }).finally(() => {
      if (generation === historyGeneration.current) { historyInFlight.current = false; setHistoryLoading(false); }
    });
    return () => { historyGeneration.current += 1; };
  }, [activeTopic, courseId, enabled, progressEpoch, user]);

  async function loadOlderMessages() {
    const current = stateRef.current;
    if (!user || !current || historyInFlight.current) return;
    const generation = historyGeneration.current;
    const savedHistory = history?.topicId === current.active_topic_id && history.epoch === current.progress_epoch ? history : null;
    historyInFlight.current = true;
    setHistoryLoading(true);
    setHistoryFailure(null);
    try {
      const page = await requestTutor<{ messages: TutorState["conversation"]["messages"]; next_cursor: string | null }>(
        user, courseId, undefined, { query: `&view=history&topicId=${encodeURIComponent(current.active_topic_id)}${savedHistory?.cursor ? `&before=${encodeURIComponent(savedHistory.cursor)}` : ""}` },
      );
      if (generation !== historyGeneration.current) return;
      setHistory((latest) => ({
        topicId: current.active_topic_id, epoch: current.progress_epoch,
        messages: mergeTutorMessages(page.messages,
          latest?.topicId === current.active_topic_id && latest.epoch === current.progress_epoch ? latest.messages : []),
        cursor: page.next_cursor, loaded: true,
      }));
    } catch {
      if (generation === historyGeneration.current) setHistoryFailure({
        topicId: current.active_topic_id, epoch: current.progress_epoch,
        message: "We couldn't load older messages just now. Please try again.",
      });
    } finally {
      if (generation === historyGeneration.current) { historyInFlight.current = false; setHistoryLoading(false); }
    }
  }

  async function reload() {
    if (!user || !enabled || inFlight.current) return;
    setLoading(true);
    try {
      const saved = await requestTutor(user, courseId);
      saveState(saved);
      setError("");
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to reload tutor progress."); }
    finally { setLoading(false); }
  }

  function acceptSavedState(saved: TutorState) {
    saveState(saved);
    setError("");
  }

  async function perform(action: TutorAction, topicId?: string, message = "") {
    const currentState = stateRef.current;
    if (!user || !enabled || !currentState || inFlight.current || currentState.busy) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setStopped(false);
    const request = { id: crypto.randomUUID(), controller: new AbortController() };
    activeRequest.current = request;
    try {
      let saved = await requestTutor(user, courseId, {
        courseId, topicId: topicId ?? currentState.active_topic_id, action, message,
        operationId: request.id, revision: currentState.revision,
        ...(action === "confirm" ? { conceptIndex: currentState.conversation.concept_index } : {}),
      }, { signal: request.controller.signal });
      if (request.controller.signal.aborted) return false;
      if (action === "message" && saved.active_topic_id !== currentState.active_topic_id) {
        request.id = crypto.randomUUID();
        saved = await requestTutor(user, courseId, {
          courseId,
          topicId: saved.active_topic_id,
          action: "start",
          message: "",
          operationId: request.id,
          revision: saved.revision,
        }, { signal: request.controller.signal });
      }
      if (request.controller.signal.aborted) return false;
      saveState(saved);
      return true;
    } catch (failure) {
      if (request.controller.signal.aborted) return false;
      setError(failure instanceof Error ? failure.message : "The tutor request failed.");
      try {
        const saved = await requestTutor(user, courseId);
        if (request.controller.signal.aborted) return false;
        saveState(saved);
      } catch {
        if (request.controller.signal.aborted) return false;
        const latest = stateRef.current;
        if (latest) {
          stateRef.current = { ...latest, busy: true };
          setState(stateRef.current);
        }
      }
      return false;
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = null;
        if (!stopInFlight.current) { inFlight.current = false; setBusy(false); }
      }
    }
  }

  async function stopResponse() {
    const operationId = activeRequest.current?.id ?? stateRef.current?.pending_operation_id;
    if (!user || !operationId || stopInFlight.current) return;
    stopInFlight.current = true;
    inFlight.current = true;
    setStopping(true);
    activeRequest.current?.controller.abort();
    setError("");
    try {
      const saved = await requestTutor(user, courseId, { courseId, operationId }, { query: "&action=cancel" });
      saveState(saved);
      setStopped(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "We couldn't confirm the stop yet. Check your saved lesson before continuing.");
      const latest = stateRef.current;
      if (latest) {
        stateRef.current = { ...latest, busy: true, pending_operation_id: operationId };
        setState(stateRef.current);
      }
    } finally {
      activeRequest.current = null;
      stopInFlight.current = false;
      inFlight.current = false;
      setBusy(false);
      setStopping(false);
    }
  }

  const savedHistory = history?.topicId === activeTopic && history?.epoch === progressEpoch ? history : null;
  return {
    state, loading, busy: busy || stopping || !!state?.busy, error, perform, reload, acceptSavedState,
    stopResponse, stopping, stopped, canStop: busy || !!state?.pending_operation_id,
    messages: mergeTutorMessages(savedHistory?.messages ?? [], state?.conversation.messages ?? []),
    historyLoading: historyLoading || (!!activeTopic && !savedHistory?.loaded && !historyError),
    historyError, hasOlderMessages: !!savedHistory?.cursor, loadOlderMessages,
  };
}
