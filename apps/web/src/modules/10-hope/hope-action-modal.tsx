import { HOPE_SUBMISSION_CANCEL_REASON_CODES } from "@chartwarden/types";
import { Button, Modal, SelectField, t, useApiClient } from "@chartwarden/ui";
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
// `M10_SUBMISSION_RETRY_NOT_REJECTED`) — none of which this modal predicts. Sign and correct are driven
// by the assessment workspace (`hope-assessment-detail.tsx`), which carries the `ifVersion` they require.
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  RECORD_BUSY_CODE,
  type WriteResult,
  cancelSubmission,
  failedResultOutcomeUnknown,
  regenerateSchedules,
  requestSummaryPdf,
  skipSchedule,
} from "./hope-api";
import { notifyDone } from "./hope-notify-done";
import { CANCEL_REASON_LABEL } from "./hope-status";
import { useFocusOnNewError } from "./use-focus-on-new-error";

/** The ceremonies this modal performs. Each is one route; none needs a form of its own. */
export type HopeAction = "skip" | "summary-pdf" | "regenerate" | "cancel-package";

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
  "summary-pdf": "Request HOPE summary",
  regenerate: "Recompute timepoint schedules",
  "cancel-package": "Cancel HOPE package",
};

const SUBMIT: Record<HopeAction, string> = {
  skip: "Skip window",
  "summary-pdf": "Request summary",
  regenerate: "Recompute",
  "cancel-package": "Cancel package",
};

/** The request got no answer (offline, a reset, a timeout): the server may or may not have applied it. */
const ACTION_UNCONFIRMED =
  "Could not confirm that the action was applied. Check the record before trying again.";

const humanize = (k: string): string =>
  k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export interface HopeActionModalProps {
  readonly open: boolean;
  readonly action: HopeAction;
  /** The subject: a schedule id, assessment id, submission id, admission id or provider-entity id. */
  readonly targetId: string;
  readonly onClose: () => void;
  /** Called after a successful commit so the caller can refresh without guessing at the new state. */
  readonly onDone: () => void;
  /**
   * The page behind the dialog may be out of date: the server said 409 (the record's state changed under the user), or the outcome could
   * not be confirmed (no answer, a timeout, a faulting 5xx), so the action may have been applied. Refresh so the page shows what is true.
   */
  readonly onConflict?: () => void;
}

/** Neither a skip nor a cancel starts with a reason: both are terminal (a skip counts against the HQRP rate, a cancelled package is dead), so the clinician must pick why. */
const NO_REASON = "";

export function HopeActionModal({
  open,
  action,
  targetId,
  onClose,
  onDone,
  onConflict,
}: HopeActionModalProps): JSX.Element | null {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonCode, setReasonCode] = useState<string>(NO_REASON);
  // A failure takes focus: the pressed button is disabled while the request is out, which drops focus to the page.
  const alertRef = useFocusOnNewError<HTMLParagraphElement>(error);

  // Reset only when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setReasonCode(NO_REASON);
  }, [open]);

  if (!open) return null;
  const needsReason =
    (action === "skip" || action === "cancel-package") && reasonCode === NO_REASON;

  function perform(): Promise<WriteResult<unknown>> {
    switch (action) {
      case "skip":
        // The route's body also accepts a `note`, but the server records only the reason code (`skipSchedule(org, id,
        // body.reasonCode)`): a Note field here would imply an explanation is kept on a terminal, HQRP-counted skip when it
        // is dropped. It comes back when the server persists it.
        return skipSchedule(client, targetId, { reasonCode });
      case "summary-pdf":
        return requestSummaryPdf(client, targetId);
      case "regenerate":
        return regenerateSchedules(client, targetId);
      case "cancel-package":
        return cancelSubmission(client, targetId, {
          reasonCode: reasonCode as (typeof HOPE_SUBMISSION_CANCEL_REASON_CODES)[number],
        });
    }
  }

  async function submit(): Promise<void> {
    if (needsReason) return;
    setBusy(true);
    setError(null);
    let res: WriteResult<unknown>;
    try {
      res = await perform();
    } catch {
      // A rejected request must free the dialog: `busy` would otherwise hold Cancel, Escape and the scrim shut for good.
      setBusy(false);
      setError(ACTION_UNCONFIRMED);
      // No answer: the action may have been applied, and the words say to check the record, so the page is re-read.
      notifyDone(() => onConflict?.());
      return;
    }
    setBusy(false);
    if (!res.ok) {
      setError(res.message); // the server's own reason (e.g. "already marked uploaded"), except where `refusalWordsOf` words it for a clinician
      // A 409 M10_RECORD_BUSY is a lock wait that timed out and the step was NOT applied: the page is not stale, so it is
      // not re-read (the server's words say to send the request again). Any other 409 is the record having changed. An
      // empty 5xx or a fault of the server's own may have been applied after all: re-read what the words say to check.
      const changed = res.status === 409 && res.code !== RECORD_BUSY_CODE;
      if (changed || failedResultOutcomeUnknown(res)) notifyDone(() => onConflict?.());
      return;
    }
    notifyDone(onDone, onClose);
  }

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      ariaLabel={LABEL[action]}
      width="28rem"
      accent={action === "skip" || action === "cancel-package" ? t.alert : t.primary}
    >
      <div style={body}>
        <h2 style={title}>{LABEL[action]}</h2>

        {action === "skip" ? (
          <>
            <SelectField
              label="Reason"
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              required
              options={[
                { value: NO_REASON, label: "Select a reason" },
                ...SKIP_REASONS.map((r) => ({ value: r, label: humanize(r) })),
              ]}
            />
            <p style={meta}>
              A skipped window is terminal and counts against the HQRP timepoint-completion rate.
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

        {action === "cancel-package" ? (
          <>
            <p style={{ margin: 0 }}>
              Only cancel a package that was not uploaded in the CMS portal. Its records are
              released and can be packaged again in a new batch. The cancelled package stays on file
              but can no longer be downloaded, marked uploaded, or have a CMS result recorded.
            </p>
            <SelectField
              label="Reason"
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              required
              options={[
                { value: NO_REASON, label: "Select a reason" },
                ...HOPE_SUBMISSION_CANCEL_REASON_CODES.map((code) => ({
                  value: code,
                  label: CANCEL_REASON_LABEL[code],
                })),
              ]}
            />
          </>
        ) : null}

        {error ? (
          <p ref={alertRef} tabIndex={-1} role="alert" style={errorText}>
            {error}
          </p>
        ) : null}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            {action === "cancel-package" ? "Keep package" : "Cancel"}
          </Button>
          <Button
            tone={action === "skip" || action === "cancel-package" ? "danger" : "primary"}
            onClick={submit}
            disabled={busy || needsReason}
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
