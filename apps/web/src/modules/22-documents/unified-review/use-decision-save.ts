// UR — saving one observation's decision from the field-task panel: the write, the workspace refresh
// that follows it, and what the reviewer is told at each step. A rejected request (no response at all)
// unlocks the panel with a message instead of leaving it "Saving"; `onBusyChange` tells the workspace
// so it does not switch task under an unfinished save. Focus is kept through the pending state.
import { useApiClient, useRestoreFocus } from "@chartwarden/ui";
import { useState } from "react";
import type { Candidate, DecisionBody, DecisionKind, Workspace } from "../doclens-api";
import { decide } from "../doclens-api";
import {
  REFRESH_FAILED_MESSAGE,
  UNREACHABLE_DECISION_MESSAGE,
  settle,
} from "./review-decision-flow";
import { visibleValue } from "./review-observation-values";

export interface DecisionExtra {
  editedValue?: string;
  reason?: string;
}

export interface StatusNote {
  readonly text: string;
  /** A saved decision is a success; a refresh that failed after it is a warning the reviewer must act on. */
  readonly tone: "success" | "warning";
}

export const NO_VALUE_ACCEPTED_MESSAGE =
  "Decision saved: accepted with no extracted value. Nothing will be written to the chart for this field.";

function decisionBody(
  candidateId: string,
  decision: DecisionKind,
  extra: DecisionExtra,
): DecisionBody {
  return {
    candidateId,
    decision,
    sourceViewConfirmed: true,
    ...(extra.editedValue !== undefined ? { editedValue: extra.editedValue } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
  };
}

function savedMessage(decision: DecisionKind, candidate: Candidate, extra: DecisionExtra): string {
  if (decision === "approve_with_edit")
    return `Decision saved: corrected to ${extra.editedValue ?? "edited value"}`;
  if (decision === "reject") return "Decision saved: rejected extracted value";
  const value = visibleValue(candidate.value);
  return value === null ? NO_VALUE_ACCEPTED_MESSAGE : `Decision saved: accepted ${value}`;
}

export interface DecisionSave {
  readonly busy: boolean;
  readonly error: string | null;
  readonly status: StatusNote | null;
  /** The decision is stored but the workspace could not be re-read: the reviewer must retry before moving on. */
  readonly refreshPending: boolean;
  readonly save: (decision: DecisionKind, extra?: DecisionExtra) => Promise<void>;
  readonly retryRefresh: () => Promise<void>;
}

export function useDecisionSave({
  reviewId,
  candidate,
  canSubmit,
  refresh,
  onRecorded,
  onSaved,
  onBusyChange,
  focusFallback,
}: {
  /** The open review this reviewer owns; null when there is none to write to. */
  reviewId: string | null;
  candidate: Candidate;
  canSubmit: boolean;
  refresh: () => Promise<Workspace | null>;
  /** The write succeeded (before the refresh): the panel locks the observation and clears the comparison. */
  onRecorded: () => void;
  /** The write and the refresh both succeeded. */
  onSaved: (latest: Workspace) => void;
  onBusyChange: (busy: boolean) => void;
  /** Where focus goes when the control that started the save is gone (the form closed). */
  focusFallback: () => HTMLElement | null | undefined;
}): DecisionSave {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusNote | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const captureFocus = useRestoreFocus(busy, focusFallback);

  const setPending = (pending: boolean): void => {
    setBusy(pending);
    onBusyChange(pending);
  };

  async function save(decision: DecisionKind, extra: DecisionExtra = {}): Promise<void> {
    if (reviewId === null || !canSubmit || busy || refreshPending) return;
    captureFocus();
    setPending(true);
    setError(null);
    setStatus(null);
    const result = await settle(() =>
      decide(client, reviewId, decisionBody(candidate.id, decision, extra)),
    );
    if (result === null || !result.ok) {
      setPending(false);
      setError(result === null ? UNREACHABLE_DECISION_MESSAGE : result.message);
      return;
    }
    onRecorded();
    const latest = await settle(refresh);
    setPending(false);
    if (latest === null) {
      setRefreshPending(true);
      setStatus({ text: REFRESH_FAILED_MESSAGE, tone: "warning" });
      return;
    }
    setStatus({ text: savedMessage(decision, candidate, extra), tone: "success" });
    onSaved(latest);
  }

  async function retryRefresh(): Promise<void> {
    captureFocus();
    setPending(true);
    const latest = await settle(refresh);
    setPending(false);
    if (latest === null) return;
    setRefreshPending(false);
    setStatus({ text: "Decision saved and workspace refreshed.", tone: "success" });
    onSaved(latest);
  }

  return { busy, error, status, refreshPending, save, retryRefresh };
}
