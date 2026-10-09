// apps/web/src/modules/23-billing-medicare — the two DDE record forms (ADR-0052): "record as keyed in DDE" and
// "record what came back". Real <form> elements (Enter submits, fields are named), controlled by drafts the rail
// holds so a step-up round trip can restore them. Notes are capped and MBI-shaped text is refused client-side too.
import { Button, SelectField, TextAreaField, TextField } from "@wardenx/ui";
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
  draft,
  onDraft,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  draft: SubmissionDraft;
  onDraft: (d: SubmissionDraft) => void;
  onCancel: () => void;
  onSubmit: (d: SubmissionDraft) => void;
}): JSX.Element {
  const [errors, setErrors] = useState<Partial<Record<keyof SubmissionDraft, string>>>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found = validateSubmission(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(draft);
  };
  return (
    <form
      className="wx-form-stack"
      onSubmit={submit}
      noValidate
      aria-label="Record as keyed in DDE"
    >
      <p className="wx-row-sub">
        This records that you keyed the item in DDE. WardenX cannot check it, so it is your word and
        it is audited. It needs a recent re-authentication.
      </p>
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
      <FormFooter busy={busy} label="Record as keyed" onCancel={onCancel} />
    </form>
  );
}

export function OutcomeForm({
  item,
  busy,
  draft,
  onDraft,
  onCancel,
  onSubmit,
}: {
  item: DdeItem;
  busy: boolean;
  draft: OutcomeDraft;
  onDraft: (d: OutcomeDraft) => void;
  onCancel: () => void;
  onSubmit: (d: OutcomeDraft) => void;
}): JSX.Element {
  const [errors, setErrors] = useState<Partial<Record<keyof OutcomeDraft, string>>>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found = validateOutcome(draft, item);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(draft);
  };
  return (
    <form className="wx-form-stack" onSubmit={submit} noValidate aria-label="Record what came back">
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
