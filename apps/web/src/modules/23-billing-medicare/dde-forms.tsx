// apps/web/src/modules/23-billing-medicare — the two DDE record forms (ADR-0052): "record as keyed in DDE" and
// "record what came back". Real <form> elements (Enter submits, fields are named), controlled by drafts the rail
// holds so a step-up round trip can restore them. Notes are capped and MBI-shaped text is refused client-side too.
import { Button, SelectField, TextAreaField, TextField } from "@chartwarden/ui";
import { type FormEvent, useState } from "react";
import type { JSX } from "react";
import {
  type DdeItem,
  NOTES_MAX,
  type OutcomeDraft,
  type SubmissionDraft,
  isNoticeType,
  validateOutcome,
  validateSubmission,
} from "./dde-queue-model";

const NOTES_HINT = `Optional, up to ${NOTES_MAX} characters. Never enter the Medicare number (MBI).`;

function FormFooter({
  busy,
  label,
  onCancel,
}: {
  busy: boolean;
  label: string;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="wx-action-row is-end">
      <Button tone="tertiary" disabled={busy} onClick={onCancel}>
        Back
      </Button>
      <Button type="submit" disabled={busy}>
        {busy ? "Working…" : label}
      </Button>
    </div>
  );
}

export function SubmissionForm({
  busy,
  resolvingInDoubt = false,
  draft,
  onDraft,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  resolvingInDoubt?: boolean;
  draft: SubmissionDraft;
  onDraft: (d: SubmissionDraft) => void;
  onCancel: () => void;
  onSubmit: (d: SubmissionDraft) => void;
}): JSX.Element {
  const [errors, setErrors] = useState<Partial<Record<keyof SubmissionDraft, string>>>({});
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (resolvingInDoubt && draft.confirmedExistingTransaction !== true) {
      setConfirmationError(
        "Confirm that you found this transaction in DDE before resolving the uncertain attempt.",
      );
      return;
    }
    setConfirmationError(null);
    const found = validateSubmission(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(draft);
  };
  return (
    <form
      className="wx-form-stack"
      onSubmit={submit}
      noValidate
      aria-label={resolvingInDoubt ? "Record confirmed submission" : "Record manual submission"}
    >
      <p className="wx-row-sub">
        {resolvingInDoubt
          ? "Use this only after you verify the transaction exists in DDE. This resolves the uncertain attempt; it does not send anything. It needs a recent re-authentication."
          : "Complete the transaction in Medicare DDE first. This records what happened; ChartWarden does not submit anything to Medicare. It is your attestation and is audited. A recent re-authentication is required."}
      </p>
      {resolvingInDoubt ? (
        <div>
          <label>
            <input
              type="checkbox"
              checked={draft.confirmedExistingTransaction === true}
              aria-invalid={confirmationError ? true : undefined}
              aria-describedby={confirmationError ? "dde-confirm-existing-error" : undefined}
              onChange={(e) => {
                onDraft({ ...draft, confirmedExistingTransaction: e.target.checked });
                if (e.target.checked) setConfirmationError(null);
              }}
            />
            I verified this transaction exists in DDE
          </label>
          {confirmationError ? (
            <p id="dde-confirm-existing-error" role="alert">
              {confirmationError}
            </p>
          ) : null}
        </div>
      ) : null}
      <TextField
        label="DCN / ICN / receipt number"
        name="dcn"
        hint="Optional. As DDE shows it: 13 to 23 characters."
        maxLength={23}
        value={draft.dcn}
        error={errors.dcn}
        onChange={(e) => onDraft({ ...draft, dcn: e.target.value.trim() })}
      />
      <TextAreaField
        label="Notes"
        name="notes"
        hint={NOTES_HINT}
        rows={3}
        maxLength={NOTES_MAX}
        value={draft.notes}
        error={errors.notes}
        onChange={(e) => onDraft({ ...draft, notes: e.target.value })}
      />
      <FormFooter
        busy={busy}
        label={resolvingInDoubt ? "Confirm submission" : "Record submission"}
        onCancel={onCancel}
      />
    </form>
  );
}

export function OutcomeForm({
  item,
  resolvingInDoubt = false,
  busy,
  draft,
  onDraft,
  onCancel,
  onSubmit,
}: {
  item: DdeItem;
  resolvingInDoubt?: boolean;
  busy: boolean;
  draft: OutcomeDraft;
  onDraft: (d: OutcomeDraft) => void;
  onCancel: () => void;
  onSubmit: (d: OutcomeDraft) => void;
}): JSX.Element {
  const [errors, setErrors] = useState<Partial<Record<keyof OutcomeDraft, string>>>({});
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (resolvingInDoubt && draft.confirmedExistingTransaction !== true) {
      setConfirmationError(
        "Confirm that you found this transaction and outcome in DDE before resolving the uncertain attempt.",
      );
      return;
    }
    setConfirmationError(null);
    const found = validateOutcome(draft, item);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(draft);
  };
  return (
    <form
      className="wx-form-stack"
      onSubmit={submit}
      noValidate
      aria-label={resolvingInDoubt ? "Record confirmed outcome" : "Record what came back"}
    >
      {resolvingInDoubt ? (
        <div>
          <p className="wx-row-sub">
            Record an outcome only after confirming this transaction and its current status in DDE.
            This does not submit anything.
          </p>
          <label>
            <input
              type="checkbox"
              checked={draft.confirmedExistingTransaction === true}
              aria-invalid={confirmationError ? true : undefined}
              aria-describedby={confirmationError ? "dde-confirm-outcome-error" : undefined}
              onChange={(e) => {
                onDraft({ ...draft, confirmedExistingTransaction: e.target.checked });
                if (e.target.checked) setConfirmationError(null);
              }}
            />
            I verified this transaction and outcome in DDE
          </label>
          {confirmationError ? (
            <p id="dde-confirm-outcome-error" role="alert">
              {confirmationError}
            </p>
          ) : null}
        </div>
      ) : null}
      <SelectField
        label="What came back"
        name="outcome"
        required
        value={draft.outcome}
        error={errors.outcome}
        options={[
          { value: "", label: "Select…" },
          { value: "accepted", label: "Accepted by the MAC (needs re-authentication)" },
          { value: "returned", label: "Returned / rejected" },
        ]}
        onChange={(e) => onDraft({ ...draft, outcome: e.target.value as OutcomeDraft["outcome"] })}
      />
      {draft.outcome === "accepted" ? (
        <TextField
          label="MAC acceptance date"
          name="macAcceptedOn"
          type="date"
          required={isNoticeType(item.itemType)}
          hint={
            isNoticeType(item.itemType)
              ? "The date DDE shows. The notice is treated as accepted on this date."
              : "Optional. The date DDE shows."
          }
          value={draft.macAcceptedOn}
          error={errors.macAcceptedOn}
          onChange={(e) => onDraft({ ...draft, macAcceptedOn: e.target.value })}
        />
      ) : null}
      {draft.outcome === "returned" ? (
        <TextField
          label="RTP reason code"
          name="rtpReasonCode"
          required
          maxLength={8}
          value={draft.rtpReasonCode}
          error={errors.rtpReasonCode}
          onChange={(e) =>
            onDraft({ ...draft, rtpReasonCode: e.target.value.toUpperCase().trim() })
          }
        />
      ) : null}
      <TextField
        label="DCN / ICN / receipt number"
        name="dcn"
        hint="Optional. 13 to 23 characters."
        maxLength={23}
        value={draft.dcn}
        error={errors.dcn}
        onChange={(e) => onDraft({ ...draft, dcn: e.target.value.trim() })}
      />
      <TextAreaField
        label="Notes"
        name="notes"
        hint={NOTES_HINT}
        rows={3}
        maxLength={NOTES_MAX}
        value={draft.notes}
        error={errors.notes}
        onChange={(e) => onDraft({ ...draft, notes: e.target.value })}
      />
      <FormFooter busy={busy} label="Record outcome" onCancel={onCancel} />
    </form>
  );
}
