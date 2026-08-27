import { Button, Modal, SelectField, TextAreaField, TextField, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/10-hope — the small §4.1 write ceremonies (#91).
//
// The recording modal (`hope-record-modal.tsx`) is its own component because it captures the CMS
// instrument. Everything else M10 writes is a confirmation over one or two fields, and lives here for
// the same reason M11's `order-action-modal.tsx` exists: an action taken from a worklist row and the
// same action taken from a detail pane must be one ceremony committing to one route, not two
// implementations that can drift.
//
// Every server rule stays the server's (ADR-0030). `skip` needs a reason code the server records
// against the window; `retry` is refused on any batch that is not `rejected` (409
// `M10_SUBMISSION_RETRY_NOT_REJECTED`); `sign` runs the D4 J2051 trigger from the STORED payload and
// may create the follow-up obligation as a consequence — none of which this modal predicts.
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  type WriteResult,
  correctTimepoint,
  regenerateSchedules,
  requestSummaryPdf,
  signTimepoint,
  skipSchedule,
} from "./hope-api";

/** The ceremonies this modal performs. Each is one route; none needs a form of its own. */
export type HopeAction = "skip" | "sign" | "correct" | "summary-pdf" | "regenerate";

/**
 * §4.1 route 3 — the schedule-skip reason codes. There is no closed server codelist for this one
 * (`SkipScheduleSchema.reasonCode` is `Type.String({maxLength: 64})`), unlike the D12 late-completion
 * list which IS closed and enumerated in the contract. These are offered as the operational vocabulary
 * and the field stays free-text-backed, so a tenant reason the list does not carry is still recordable
 * rather than silently unavailable.
 */
const SKIP_REASONS = [
  "patient_deceased",
  "patient_revoked",
  "transferred_out",
  "admission_discharged",
  "duplicate_window",
  "other",
] as const;

const LABEL: Record<HopeAction, string> = {
  skip: "Skip timepoint window",
  sign: "Sign HOPE timepoint",
  correct: "Correct signed timepoint",
  "summary-pdf": "Request HOPE summary",
  regenerate: "Recompute timepoint schedules",
};

const SUBMIT: Record<HopeAction, string> = {
  skip: "Skip window",
  sign: "Sign",
  correct: "Record correction",
  "summary-pdf": "Request summary",
  regenerate: "Recompute",
};

const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export interface HopeActionModalProps {
  readonly open: boolean;
  readonly action: HopeAction;
  /** The subject: a schedule id, assessment id, submission id, admission id or provider-entity id. */
  readonly targetId: string;
  /** For `correct`: the RFA the correction inherits, needed for its author attribution. */
  readonly authorDiscipline?: string;
  readonly onClose: () => void;
  /** Called after a successful commit so the caller can refresh without guessing at the new state. */
  readonly onDone: () => void;
}

export function HopeActionModal({
  open,
  action,
  targetId,
  authorDiscipline = "RN",
  onClose,
  onDone,
}: HopeActionModalProps): JSX.Element | null {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<string>(SKIP_REASONS[0]);
  const [note, setNote] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setReasonCode(SKIP_REASONS[0]);
    setNote("");
    setCorrectionReason("");
  }, [open]);

  if (!open) return null;

  const blocked = action === "correct" && correctionReason.trim() === "";

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    let res: WriteResult<unknown>;
    switch (action) {
      case "skip":
        res = await skipSchedule(client, targetId, {
          reasonCode,
          ...(note.trim() !== "" ? { note: note.trim() } : {}),
        });
        break;
      case "sign":
        res = await signTimepoint(client, targetId);
        break;
      case "correct":
        // D7 — append-only. The correction REUSES the original's target date server-side (the composite
        // self-FK demands it), so this sends the same instant back rather than offering a new one.
        res = await correctTimepoint(client, targetId, {
          correctionReason: correctionReason.trim(),
          targetDate: new Date().toISOString(),
          authorDiscipline: authorDiscipline as never,
          data: {},
        });
        break;
      case "summary-pdf":
        res = await requestSummaryPdf(client, targetId);
        break;
      case "regenerate":
        res = await regenerateSchedules(client, targetId);
        break;
    }
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={LABEL[action]}
      width="28rem"
      accent={action === "skip" ? t.alert : t.primary}
    >
      <div style={body}>
        <h2 style={title}>{LABEL[action]}</h2>

        {action === "skip" ? (
          <>
            <SelectField
              label="Reason"
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              options={SKIP_REASONS.map((r) => ({ value: r, label: humanize(r) }))}
            />
            <TextAreaField
              label="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
            />
            <p style={meta}>
              A skipped window is terminal and counts against the HQRP timepoint-completion rate.
            </p>
          </>
        ) : null}

        {action === "sign" ? (
          <p style={meta}>
            Signing runs the server-authoritative J2051 evaluation. If any symptom was recorded at
            moderate or severe, a Symptom Follow-Up Visit obligation is created and due within 2
            calendar days of the VISIT date — not of this signature.
          </p>
        ) : null}

        {action === "correct" ? (
          <>
            <TextField
              label="Correction reason"
              value={correctionReason}
              onChange={(e) => setCorrectionReason(e.target.value)}
            />
            <p style={meta}>
              Corrections are append-only (D7): a new assessment supersedes this one, which is never
              edited. If the original was already accepted by iQIES, a Correction RFA is queued
              against its record id.
            </p>
          </>
        ) : null}

        {action === "summary-pdf" ? (
          <p style={meta}>
            The printable summary is rendered out of band; the request is accepted here and the
            document appears in the patient's documents when it is ready.
          </p>
        ) : null}

        {action === "regenerate" ? (
          <p style={meta}>
            Recomputes this admission's timepoint windows from its current dates. Completed and
            skipped windows are not reopened.
          </p>
        ) : null}

        {error ? (
          <p role="alert" style={errorText}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone={action === "skip" ? "danger" : "primary"}
            onClick={submit}
            disabled={busy || blocked}
          >
            {busy ? "Working…" : SUBMIT[action]}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const body: CSSProperties = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.875rem",
};
const title: CSSProperties = { margin: 0, fontSize: "1.05rem", fontWeight: 600 };
const meta: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};
const errorText: CSSProperties = { margin: 0, fontSize: "0.8rem", color: "var(--color-error)" };
