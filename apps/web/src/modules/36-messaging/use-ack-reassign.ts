// M36 ADR-0078 (G-6, G-2) - the state behind the two reassign dialogs. Opening reads the eligible colleagues and nothing else. One
// Idempotency-Key is minted per dialog open and sent on the POST; it is replaced after a definite refusal (a changed choice is a new
// attempt) and kept after an indeterminate one (the same attempt may have been saved, so its replay must be recognised). A refusal never says why a person is ineligible. The caller's `run` owns the busy
// state, the live announcement and the list refresh; this hook only builds the call and maps the answer to words.
import type { AckReassignCandidate, AckSupervisorReasonCode } from "@wardenx/types";
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  REASSIGN_CANNOT_TAKE_TEXT,
  REASSIGN_CHANGED_TEXT,
  REASSIGN_COLLEAGUE_FALLBACK,
  REASSIGN_FAILED_TEXT,
  REASSIGN_INDETERMINATE_TEXT,
  REASSIGN_NOT_PERMITTED_TEXT,
  REASSIGN_SAVED_CARD_TEXT,
  REASSIGN_SAVED_SUPERVISOR_TEXT,
  REASSIGN_SIGN_IN_TEXT,
  REASSIGN_TOO_MANY_TEXT,
} from "./ack-reassign-wording";

export type ReassignMode = "party" | "supervisor";

/** `stay`: the dialog stays open and shows `text`. `done`: the dialog closes; the caller announces `text` and refreshes. */
export type ReassignResult =
  | { readonly kind: "stay"; readonly text: string }
  | { readonly kind: "done"; readonly text: string; readonly failure: boolean };
export type ReassignRun = (perform: () => Promise<ReassignResult>) => Promise<ReassignResult>;

/** Typed loosely: the generated path union makes the full client type too deep to instantiate here. */
interface ReassignClient {
  GET(
    path: string,
    init: { params: { path: { id: string } } },
  ): Promise<{
    data?: { candidates?: AckReassignCandidate[] };
    response?: { status: number };
  }>;
  POST(
    path: string,
    init: {
      params: { path: { id: string }; header: { "Idempotency-Key": string } };
      body: Record<string, string>;
    },
  ): Promise<{ error?: unknown; response?: { status: number } }>;
}

const PATHS = {
  party: {
    candidates: "/api/v1/messaging/escalations/{id}/reassign-candidates",
    post: "/api/v1/messaging/escalations/{id}/reassign",
  },
  supervisor: {
    candidates: "/api/v1/messaging/escalations/{id}/supervisor-reassign-candidates",
    post: "/api/v1/messaging/escalations/{id}/supervisor-reassign",
  },
} as const;

export interface Colleague {
  readonly userId: string;
  readonly label: string;
}

/** A person with no usable name reads "Colleague"; equal names get an ordinal so the choices stay distinguishable. Never an id. */
export function colleagueChoices(candidates: readonly AckReassignCandidate[]): Colleague[] {
  const names = candidates.map((c) => (c.display_name ?? "").trim() || REASSIGN_COLLEAGUE_FALLBACK);
  const seen = new Map<string, number>();
  return candidates.map((c, index) => {
    const name = names[index] as string;
    const total = names.filter((n) => n === name).length;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return { userId: c.user_id, label: total > 1 ? `${name} (${n} of ${total})` : name };
  });
}

/** The words for a refusal and whether the dialog closes (the request moved on, or the outcome is unknown) or stays open. */
export function reassignFailure(status: number | undefined): ReassignResult {
  if (status === undefined || status === 408 || status >= 500) {
    return { kind: "done", text: REASSIGN_INDETERMINATE_TEXT, failure: true };
  }
  if (status === 404 || status === 409) {
    return { kind: "done", text: REASSIGN_CHANGED_TEXT, failure: true };
  }
  if (status === 422) return { kind: "stay", text: REASSIGN_CANNOT_TAKE_TEXT };
  if (status === 429) return { kind: "stay", text: REASSIGN_TOO_MANY_TEXT };
  if (status === 401) return { kind: "stay", text: REASSIGN_SIGN_IN_TEXT };
  if (status === 403) return { kind: "stay", text: REASSIGN_NOT_PERMITTED_TEXT };
  return { kind: "stay", text: REASSIGN_FAILED_TEXT };
}

export type CandidatesState =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly colleagues: readonly Colleague[] };

export function useAckReassign(mode: ReassignMode, requestId: string, run: ReassignRun) {
  const client = useApiClient() as unknown as ReassignClient;
  const [candidates, setCandidates] = useState<CandidatesState>({ status: "loading" });
  const [userId, setUserIdRaw] = useState<string | null>(null);
  const [reason, setReasonRaw] = useState<AckSupervisorReasonCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const key = useRef<string>(crypto.randomUUID());
  const inFlight = useRef(false);
  const token = useRef(0);
  // A changed choice clears the last refusal; a choice made while a call is in flight is ignored (the call keeps the one it was sent with).
  const setUserId = useCallback((value: string | null): void => {
    if (inFlight.current) return;
    setError(null);
    setUserIdRaw(value);
  }, []);
  const setReason = useCallback((value: AckSupervisorReasonCode | null): void => {
    if (inFlight.current) return;
    setError(null);
    setReasonRaw(value);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    token.current += 1;
    const mine = token.current;
    setCandidates({ status: "loading" });
    try {
      const { data, response } = await client.GET(PATHS[mode].candidates, {
        params: { path: { id: requestId } },
      });
      if (mine !== token.current) return;
      const list = data?.candidates;
      if (!list || (response?.status ?? 200) >= 400) return setCandidates({ status: "error" });
      setCandidates({ status: "ready", colleagues: colleagueChoices(list) });
      setUserIdRaw((prev) => (list.some((c) => c.user_id === prev) ? prev : null));
    } catch {
      if (mine === token.current) setCandidates({ status: "error" });
    }
  }, [client, mode, requestId]);

  useEffect(() => {
    void load();
    return () => {
      token.current += 1;
    };
  }, [load]);

  const ready = userId !== null && (mode === "party" || reason !== null);

  /** Returns the result so the dialog can close itself on `done`; a second call while one is in flight does nothing. */
  const submit = useCallback(async (): Promise<ReassignResult | null> => {
    if (inFlight.current || userId === null || (mode === "supervisor" && reason === null)) {
      return null;
    }
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const body: Record<string, string> =
      mode === "supervisor" && reason
        ? { assigned_user_id: userId, reason_code: reason }
        : { assigned_user_id: userId };
    const perform = async (): Promise<ReassignResult> => {
      try {
        const result = await client.POST(PATHS[mode].post, {
          params: { path: { id: requestId }, header: { "Idempotency-Key": key.current } },
          body,
        });
        const status = result?.response?.status;
        if (result?.error || status === undefined || status >= 400) {
          const failure = reassignFailure(status);
          const unknown = status === undefined || status === 408 || status >= 500;
          if (!unknown) key.current = crypto.randomUUID();
          return failure;
        }
        return {
          kind: "done",
          text: mode === "supervisor" ? REASSIGN_SAVED_SUPERVISOR_TEXT : REASSIGN_SAVED_CARD_TEXT,
          failure: false,
        };
      } catch {
        return reassignFailure(undefined);
      }
    };
    try {
      const result = await run(perform);
      if (result.kind === "stay") setError(result.text);
      return result;
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }, [client, mode, requestId, reason, run, userId]);

  return {
    candidates,
    load,
    userId,
    setUserId,
    reason,
    setReason,
    error,
    submitting,
    ready,
    submit,
  };
}
