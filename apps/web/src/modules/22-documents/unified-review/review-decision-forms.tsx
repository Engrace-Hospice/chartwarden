// UR — the accept / edit / reject controls of one observation. The panel remounts this component (a new
// `key`) when a decision is saved or "Change decision" starts, which clears what the reviewer typed:
// the accept reason and the reject reason are separate, and neither survives into the next decision.
import { Glyph, TextField, useEditorFocus } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { Candidate, DecisionKind } from "../doclens-api";
import { MIN_REASON } from "../doclens-model";
import { visibleValue } from "./review-observation-values";
import { ReasonForm } from "./review-reason-form";
import type { DecisionExtra } from "./use-decision-save";

type DecisionMode = "edit" | "reject" | null;

export const NO_VALUE_NOTE =
  "No value was extracted. Accepting records that and writes nothing to the chart; use Edit to enter the value.";

const ACCEPT_REASON_LABEL = "Reason for accepting despite the page reading";

function describedBy(...ids: readonly (string | undefined)[]): string | undefined {
  const present = ids.filter(Boolean).join(" ");
  return present || undefined;
}

export function DecisionForms({
  candidate,
  canSubmit,
  busy,
  locked,
  hintId,
  onSave,
}: {
  candidate: Candidate;
  /** A decision can be recorded now: the source is shown and compared, and nothing is pending or recorded. */
  canSubmit: boolean;
  busy: boolean;
  /** A decision is already recorded and the reviewer has not chosen to change it. */
  locked: boolean;
  /** The element that says what unlocks the buttons; the disabled controls point at it. */
  hintId?: string;
  onSave: (decision: DecisionKind, extra: DecisionExtra) => void;
}): JSX.Element {
  const [mode, setMode] = useState<DecisionMode>(null);
  const [editValue, setEditValue] = useState("");
  const [acceptReason, setAcceptReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const editReturn = `unified-edit-${candidate.id}`;
  const rejectReturn = `unified-reject-${candidate.id}`;
  // Closing a form hands focus back to the control that opened it, even though that control unmounted.
  useEditorFocus(mode === "edit", editReturn);
  useEditorFocus(mode === "reject", rejectReturn);

  const visionReasonRequired = candidate.vision.status === "disagreed";
  const noValueId = `unified-no-value-${candidate.id}`;
  const hasNoValue = visibleValue(candidate.value) === null;
  const trimmedEdit = editValue.trim();
  const trimmedReject = rejectReason.trim();
  const rejectReasonShort = trimmedReject.length > 0 && trimmedReject.length < MIN_REASON;

  const openEdit = (): void => {
    setEditValue(candidate.decision?.editedValue ?? candidate.value ?? "");
    setMode("edit");
  };
  const submitEdit = (): void => {
    if (trimmedEdit) onSave("approve_with_edit", { editedValue: trimmedEdit });
  };
  const submitReject = (): void => {
    if (!rejectReasonShort) onSave("reject", trimmedReject ? { reason: trimmedReject } : {});
  };

  if (mode === "edit")
    return (
      <ReasonForm
        id={`unified-edit-${candidate.id}`}
        label="Corrected value"
        value={editValue}
        submitLabel="Save corrected value"
        busy={busy}
        canSubmit={canSubmit && trimmedEdit.length > 0}
        onChange={setEditValue}
        onSubmit={submitEdit}
        onCancel={() => setMode(null)}
      />
    );
  if (mode === "reject")
    return (
      <ReasonForm
        id={`unified-reject-${candidate.id}`}
        label={`Rejection reason (optional; at least ${MIN_REASON} characters if entered)`}
        value={rejectReason}
        submitLabel="Reject extracted value"
        busy={busy}
        canSubmit={canSubmit && !rejectReasonShort}
        onChange={setRejectReason}
        onSubmit={submitReject}
        onCancel={() => setMode(null)}
      />
    );

  return (
    <>
      {visionReasonRequired && !locked ? (
        <TextField
          type="text"
          autoComplete="off"
          label={ACCEPT_REASON_LABEL}
          hint={`The vision check read “${candidate.vision.observedValue ?? "—"}”. Give a reason to accept the extracted value unchanged, or edit it to the supported value.`}
          value={acceptReason}
          onChange={(event) => setAcceptReason(event.target.value)}
        />
      ) : null}
      <div className="wx-unified-decision-actions">
        <button
          type="button"
          className="wx-btn-primary"
          aria-label="Accept extracted value"
          aria-describedby={describedBy(hintId, hasNoValue ? noValueId : undefined)}
          disabled={
            !canSubmit || busy || (visionReasonRequired && acceptReason.trim().length < MIN_REASON)
          }
          onClick={() =>
            onSave("approve", visionReasonRequired ? { reason: acceptReason.trim() } : {})
          }
        >
          <Glyph name="check" size={16} /> Accept
        </button>
        <button
          type="button"
          className="wx-btn-secondary"
          aria-label="Edit value"
          aria-describedby={describedBy(hintId)}
          data-editor-return={editReturn}
          disabled={!canSubmit || busy}
          onClick={openEdit}
        >
          <Glyph name="pencil" size={16} /> Edit
        </button>
        <button
          type="button"
          className="wx-btn-secondary"
          aria-label="Reject extracted value"
          aria-describedby={describedBy(hintId)}
          data-editor-return={rejectReturn}
          disabled={!canSubmit || busy}
          onClick={() => setMode("reject")}
        >
          <Glyph name="x-circle" size={16} /> Reject
        </button>
      </div>
      {hasNoValue ? (
        <p id={noValueId} className="wx-row-sub">
          {NO_VALUE_NOTE}
        </p>
      ) : null}
    </>
  );
}
