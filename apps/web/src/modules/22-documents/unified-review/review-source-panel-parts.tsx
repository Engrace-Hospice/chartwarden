// UR — the pieces of the field-task panel that hold no state of their own: its header, the status
// line, the footer, the read-only explanation and the hint that says what unlocks the decision.
import { Glyph, InlineAlert, StatusPill } from "@chartwarden/ui";
import type { JSX, RefObject } from "react";
import { Link } from "react-router-dom";
import type { Candidate, PlatformSupportAccess, Workspace } from "../doclens-api";
import {
  PART2_WITHHELD_MESSAGE,
  decisionLabel,
  docTypeLabel,
  fieldLabel,
  pct,
} from "../doclens-model";
import {
  NO_VALUE_LABEL,
  effectiveObservationValue,
  visibleValue,
} from "./review-observation-values";
import type { DecisionSave } from "./use-decision-save";

const LOCKED_HINT =
  "A decision is recorded for this observation. Choose Change decision to record a different one.";
const SOURCE_NOT_READY_HINT = "The decision buttons unlock once the source page has loaded.";
const NOT_COMPARED_HINT =
  "Select “I compared this with the source” to unlock the decision buttons.";
const REFRESH_FIRST_HINT = "Retry the workspace refresh before recording another decision.";

export function reviewComplete(workspace: Workspace): boolean {
  return workspace.review?.status === "complete" || workspace.batch.status === "writeback_complete";
}

function detailPath(batchId: string, candidateId: string, returnTo: string | null): string {
  const query = new URLSearchParams({ mode: "detailed", from: "unified", candidate: candidateId });
  if (returnTo) query.set("returnTo", returnTo);
  return `/intake/${encodeURIComponent(batchId)}/review?${query.toString()}`;
}

function headerValue(candidate: Candidate): string {
  return candidate.redacted
    ? "Protected value withheld"
    : (visibleValue(effectiveObservationValue(candidate)) ?? NO_VALUE_LABEL);
}

/** The saved state of an observation, shown in the task header so it never reads as pre-edit. */
function savedDecisionLine(candidate: Candidate): string | null {
  const { decision } = candidate;
  if (!decision || candidate.redacted) return null;
  const extracted =
    decision.decision === "approve_with_edit" && decision.editedValue !== null
      ? ` · Extracted: ${visibleValue(candidate.value) ?? NO_VALUE_LABEL}`
      : "";
  return `Saved decision: ${decisionLabel(decision.decision)}${extracted}`;
}

/** What the reviewer must do to unlock the decision buttons; null when nothing blocks them. */
export function unlockHint(state: {
  locked: boolean;
  refreshPending: boolean;
  sourceReady: boolean;
  sourceConfirmed: boolean;
}): string | null {
  if (state.locked) return LOCKED_HINT;
  if (state.refreshPending) return REFRESH_FIRST_HINT;
  if (!state.sourceReady) return SOURCE_NOT_READY_HINT;
  return state.sourceConfirmed ? null : NOT_COMPARED_HINT;
}

/** Why no decision can be recorded from this view, when none can. */
export function ReadOnlyNotice({
  candidate,
  workspace,
  supportAccess,
}: {
  candidate: Candidate;
  workspace: Workspace;
  supportAccess: PlatformSupportAccess | null | undefined;
}): JSX.Element {
  const { review } = workspace;
  if (supportAccess)
    return (
      <p className="wx-row-sub">
        Support-session access is read-only. Candidate decisions remain with an authorized tenant
        reviewer.
      </p>
    );
  if (candidate.redacted)
    return <p>{PART2_WITHHELD_MESSAGE} No candidate decision is available from this view.</p>;
  return (
    <p className="wx-row-sub">
      {reviewComplete(workspace)
        ? "Review complete — decisions are read-only."
        : review?.status === "in_progress"
          ? "Another reviewer owns this review."
          : "Start the review before recording candidate decisions."}
    </p>
  );
}

export function TaskHeader({
  candidate,
  onClose,
  busy,
}: {
  candidate: Candidate;
  onClose: () => void;
  /** True while a decision is being saved: the task cannot close under it. */
  busy: boolean;
}): JSX.Element {
  const savedLine = savedDecisionLine(candidate);
  return (
    <header>
      <div>
        <span className="wx-unified-category">Review task · Page {candidate.page}</span>
        <h2 tabIndex={-1} data-task-heading>
          {fieldLabel(candidate.fieldPath)}
        </h2>
        <p>
          {`${headerValue(candidate)} · ${docTypeLabel(candidate.documentType)} · ${pct(candidate.confidence)} confidence`}
        </p>
        {savedLine ? <p>{savedLine}</p> : null}
      </div>
      <button
        type="button"
        className="wx-btn-secondary wx-btn-sm"
        disabled={busy}
        onClick={onClose}
      >
        <Glyph name="close" size={15} /> Close task
      </button>
    </header>
  );
}

/** The always-mounted status line (so a change is announced), the refresh retry and the save error. */
export function DecisionStatus({
  saving,
  statusRef,
}: {
  saving: DecisionSave;
  statusRef: RefObject<HTMLOutputElement>;
}): JSX.Element {
  return (
    <>
      <output ref={statusRef} tabIndex={-1} className="wx-unified-status">
        {saving.status ? (
          <InlineAlert tone={saving.status.tone} live={false}>
            {saving.status.text}
          </InlineAlert>
        ) : null}
      </output>
      {saving.refreshPending ? (
        <button
          type="button"
          className="wx-btn-secondary"
          disabled={saving.busy}
          onClick={() => void saving.retryRefresh()}
        >
          <Glyph name="rotate-ccw" size={16} />{" "}
          {saving.busy ? "Refreshing…" : "Retry workspace refresh"}
        </button>
      ) : null}
      {saving.error ? <InlineAlert tone="error">{saving.error}</InlineAlert> : null}
    </>
  );
}

export function PanelFooter({
  batchId,
  candidate,
  returnTo,
  decisionsAvailable,
  supportAccess,
}: {
  batchId: string;
  candidate: Candidate;
  returnTo: string | null;
  decisionsAvailable: boolean;
  supportAccess: PlatformSupportAccess | null | undefined;
}): JSX.Element {
  return (
    <footer>
      <p>
        {decisionsAvailable
          ? "Opening this preview does not confirm the source. A decision is sent only after the source is visible and the comparison checkbox is selected."
          : "Opening this preview does not record a decision."}
      </p>
      {!supportAccess ? (
        <details className="wx-unified-advanced-tools">
          <summary>Advanced tools</summary>
          <Link className="wx-btn-secondary" to={detailPath(batchId, candidate.id, returnTo)}>
            Leave unified workspace for legacy reviewer <Glyph name="arrow-right" size={16} />
          </Link>
        </details>
      ) : null}
      {candidate.decision ? (
        <StatusPill label={decisionLabel(candidate.decision.decision)} tone="success" />
      ) : null}
    </footer>
  );
}
