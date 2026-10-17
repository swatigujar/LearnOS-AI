"use client";

import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { useAuth } from "@/lib/auth-context";

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
  topic_status: Record<string, "not_started" | "in_progress" | "completed">;
  module_status: Record<string, "not_started" | "in_progress" | "completed">;
  conversation: {
    concepts: string[];
    concept_index: number;
    taught_index: number | null;
    answered_index: number | null;
    messages: { role: "user" | "assistant"; text: string; reply: TutorReply | null; channel: "chat" | "voice" }[];
  };
  can_confirm: boolean;
};
export type TutorAction = "start" | "message" | "explain" | "confirm" | "confirm_module" | "pause" | "resume" | "select" | "repeat" | "restart";

export function friendlyTutorError(status: number, detail = "") {
  if (status === 429) return "The tutor has reached its AI request limit for now. Your progress is saved. Please try again later.";
  if (status === 503) return "The tutor is temporarily unavailable. Your progress is safe; please try again shortly.";
  if (status === 504) return "The tutor took longer than expected to respond. Your progress is safe; please try again.";
  if (status === 401) return "Your sign-in needs refreshing. Please sign in again to continue your lesson.";
  if (status === 404) return "This course is no longer available. Return to your courses and choose another lesson.";
  if (status === 409 && detail.toLowerCase().includes("paused")) return "This lesson is paused. Resume it from Lesson controls to continue.";
  if (status === 409 && detail.toLowerCase().includes("earlier course progress")) return "This voice session ended after the course restarted. Start a new session to continue.";
  if (status === 409) return "Your lesson changed while we were talking. Reload the saved lesson, then try again.";
  if (status === 422) return "I couldn't process that request. Please try rephrasing it.";
  return "I couldn't prepare a reliable tutor reply just now. Your progress is safe; please try again.";
}

export function friendlyTutorFailure(failure: unknown) {
  const detail = failure instanceof Error ? failure.message : "";
  const normalized = detail.toLowerCase();
  if (failure instanceof Error && failure.name === "TimeoutError" || /timed out|deadline/.test(normalized)) {
    return "Live voice couldn't connect in time. Check microphone access or your network, then try again or continue in chat.";
  }
  if (/\b429\b|quota|rate.?limit|request limit/.test(normalized)) return friendlyTutorError(429);
  if (/notallowed|microphone permission|microphone access/.test(normalized)) {
    return "Microphone access is off. Allow it in your browser settings, or continue in chat.";
  }
  if (detail.startsWith("Live voice needs a supported browser")) return detail;
  if (/network|fetch|temporarily unavailable/.test(normalized)) return friendlyTutorError(503);
  return friendlyTutorError(502);
}

async function requestTutor(user: User, courseId: string, body?: object): Promise<TutorState> {
  let token: string;
  try { token = await user.getIdToken(); }
  catch { throw new Error(friendlyTutorError(401)); }
  let response: Response;
  try {
    response = await fetch(body ? "/api/tutor" : `/api/tutor?courseId=${encodeURIComponent(courseId)}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(body ? 155_000 : 20_000),
    });
  } catch (failure) {
    throw new Error(failure instanceof Error && failure.name === "TimeoutError"
      ? friendlyTutorError(504)
      : friendlyTutorError(503));
  }
  let result: { detail?: string; message?: string };
  try { result = await response.json(); }
  catch { throw new Error(friendlyTutorError(502)); }
  if (!response.ok) throw new Error(friendlyTutorError(response.status, result.detail ?? result.message ?? ""));
  return result as TutorState;
}

export function useTutor(courseId: string, enabled: boolean) {
  const { user } = useAuth();
  const [state, setState] = useState<TutorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stateRef = useRef<TutorState | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!user || !enabled) return;
    let active = true;
    requestTutor(user, courseId)
      .then((saved) => { if (active) { stateRef.current = saved; setState(saved); setError(""); } })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Unable to load tutor progress."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [courseId, enabled, user]);

  async function reload() {
    if (!user || !enabled || inFlight.current) return;
    setLoading(true);
    try {
      const saved = await requestTutor(user, courseId);
      stateRef.current = saved;
      setState(saved);
      setError("");
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to reload tutor progress."); }
    finally { setLoading(false); }
  }

  function acceptSavedState(saved: TutorState) {
    stateRef.current = saved;
    setState(saved);
    setError("");
  }

  async function perform(action: TutorAction, topicId?: string, message = "") {
    const currentState = stateRef.current;
    if (!user || !enabled || !currentState || inFlight.current || currentState.busy) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      let saved = await requestTutor(user, courseId, {
        courseId, topicId: topicId ?? currentState.active_topic_id, action, message,
        operationId: crypto.randomUUID(), revision: currentState.revision,
        ...(action === "confirm" ? { conceptIndex: currentState.conversation.concept_index } : {}),
      });
      if (action === "message" && saved.active_topic_id !== currentState.active_topic_id) {
        saved = await requestTutor(user, courseId, {
          courseId,
          topicId: saved.active_topic_id,
          action: "start",
          message: "",
          operationId: crypto.randomUUID(),
          revision: saved.revision,
        });
      }
      stateRef.current = saved;
      setState(saved);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The tutor request failed.");
      try {
        const saved = await requestTutor(user, courseId);
        stateRef.current = saved;
        setState(saved);
      } catch {
        const latest = stateRef.current;
        if (latest) {
          stateRef.current = { ...latest, busy: true };
          setState(stateRef.current);
        }
      }
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return { state, loading, busy: busy || !!state?.busy, error, perform, reload, acceptSavedState };
}
