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
    messages: { role: "user" | "assistant"; text: string; reply: TutorReply | null }[];
  };
  can_confirm: boolean;
};
export type TutorAction = "start" | "message" | "explain" | "confirm" | "confirm_module" | "pause" | "resume" | "select" | "repeat";

export class TutorRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "TutorRequestError";
  }
}

function errorFromResponse(status: number, payload: unknown) {
  const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const detail = typeof data.detail === "string" ? data.detail : undefined;
  const message = typeof data.message === "string" ? data.message : undefined;
  const code = typeof data.code === "string" && /^[A-Z0-9_]{1,64}$/.test(data.code) ? data.code : undefined;
  const safeMessage = (detail ?? message)?.slice(0, 500)
    ?? (status === 401 ? "Your sign-in could not be verified. Sign in again." : "The tutor service rejected the request.");
  return new TutorRequestError(safeMessage, status, code);
}

async function requestTutor(user: User, courseId: string, body?: object): Promise<TutorState> {
  let token: string;
  try {
    token = await user.getIdToken();
  } catch {
    throw new TutorRequestError("Firebase could not provide a sign-in token. Sign in again and retry.", undefined, "FIREBASE_TOKEN_UNAVAILABLE");
  }

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
    const timedOut = failure instanceof Error && failure.name === "TimeoutError";
    throw new TutorRequestError(
      timedOut ? "The tutor request timed out. Check service status before retrying." : "The tutor endpoint could not be reached. Check the frontend-to-backend connection.",
      undefined,
      timedOut ? "TUTOR_REQUEST_TIMEOUT" : "TUTOR_TRANSPORT_ERROR",
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new TutorRequestError("The tutor service returned an unreadable response.", response.status, "TUTOR_INVALID_RESPONSE");
  }
  if (!response.ok) throw errorFromResponse(response.status, result);
  return result as TutorState;
}

export function useTutor(courseId: string, enabled: boolean) {
  const { user } = useAuth();
  const [state, setState] = useState<TutorState | null>(null);
  const [reloading, setReloading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TutorRequestError | null>(null);
  const inFlight = useRef(false);
  const loading = reloading || (enabled && !!user && !state && !error);

  useEffect(() => {
    if (!user || !enabled) return;
    let active = true;
    void requestTutor(user, courseId)
      .then((saved) => { if (active) { setState(saved); setError(null); } })
      .catch((failure: unknown) => { if (active) setError(failure instanceof TutorRequestError ? failure : new TutorRequestError("Unable to load tutor progress.")); });
    return () => { active = false; };
  }, [courseId, enabled, user]);

  async function reload() {
    if (!user || !enabled || inFlight.current) return;
    setReloading(true);
    try { setState(await requestTutor(user, courseId)); setError(null); }
    catch (failure) { setError(failure instanceof TutorRequestError ? failure : new TutorRequestError("Unable to reload tutor progress.")); }
    finally { setReloading(false); }
  }

  async function perform(action: TutorAction, topicId?: string, message = "") {
    if (!user || !enabled || !state || inFlight.current || state.busy) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = await requestTutor(user, courseId, {
        courseId, topicId: topicId ?? state.active_topic_id, action, message,
        operationId: crypto.randomUUID(), revision: state.revision,
        ...(action === "confirm" ? { conceptIndex: state.conversation.concept_index } : {}),
      });
      setState(saved);
      return true;
    } catch (failure) {
      setError(failure instanceof TutorRequestError ? failure : new TutorRequestError("The tutor request failed."));
      try { setState(await requestTutor(user, courseId)); }
      catch { setState((current) => current ? { ...current, busy: true } : current); }
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return { state, loading, busy: busy || !!state?.busy, error, perform, reload };
}