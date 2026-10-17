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
export type TutorAction = "start" | "message" | "explain" | "confirm" | "confirm_module" | "pause" | "resume" | "select" | "repeat";

async function requestTutor(user: User, courseId: string, body?: object): Promise<TutorState> {
  const token = await user.getIdToken();
  const response = await fetch(body ? "/api/tutor" : `/api/tutor?courseId=${encodeURIComponent(courseId)}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(body ? 155_000 : 20_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail ?? result.message ?? "The tutor request failed.");
  return result as TutorState;
}

export function useTutor(courseId: string, enabled: boolean) {
  const { user } = useAuth();
  const [state, setState] = useState<TutorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  useEffect(() => {
    if (!user || !enabled) return;
    let active = true;
    requestTutor(user, courseId)
      .then((saved) => { if (active) { setState(saved); setError(""); } })
      .catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : "Unable to load tutor progress."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [courseId, enabled, user]);

  async function reload() {
    if (!user || !enabled || inFlight.current) return;
    setLoading(true);
    try { setState(await requestTutor(user, courseId)); setError(""); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to reload tutor progress."); }
    finally { setLoading(false); }
  }

  function acceptSavedState(saved: TutorState) {
    setState(saved);
    setError("");
  }

  async function perform(action: TutorAction, topicId?: string, message = "") {
    if (!user || !enabled || !state || inFlight.current || state.busy) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await requestTutor(user, courseId, {
        courseId, topicId: topicId ?? state.active_topic_id, action, message,
        operationId: crypto.randomUUID(), revision: state.revision,
        ...(action === "confirm" ? { conceptIndex: state.conversation.concept_index } : {}),
      });
      setState(saved);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The tutor request failed.");
      try { setState(await requestTutor(user, courseId)); }
      catch { setState((current) => current ? { ...current, busy: true } : current); }
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return { state, loading, busy: busy || !!state?.busy, error, perform, reload, acceptSavedState };
}
