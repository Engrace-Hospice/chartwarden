import {
  HOPE_SCHEDULE_SKIP_REASON_CODES,
  HOPE_SUBMISSION_CANCEL_REASON_CODES,
} from "@chartwarden/types";
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
import { errorText, meta } from "./hope-dialog-styles";
import { notifyDone } from "./hope-notify-done";
import { CANCEL_REASON_LABEL, SKIP_REASON_LABEL } from "./hope-status";
import { useFocusOnNewError } from "./use-focus-on-new-error";

/** The ceremonies this modal performs. Each is one route; none needs a form of its own. */
export type HopeAction = "skip" | "summary-pdf" | "regenerate" | "cancel-package";

/**
 * §4.1 route 3 — the schedule-skip reason codes are the server's CLOSED list (`HOPE_SCHEDULE_SKIP_REASON_CODES`, the same
 * list `SkipScheduleSchema` and the service enforce): a reason is never free text, so no PHI can be typed into it, and a code
 * the list does not carry is refused (422), so the dialog offers exactly what the server accepts.
 */
const SKIP_REASONS = HOPE_SCHEDULE_SKIP_REASON_CODES;

const LABEL: Record<HopeAction, string> = {
  skip: "Skip timepoint window",
  "summary-pdf": "Request HOPE summary",
  regenerate: "Create missing timepoint windows",
  "cancel-package": "Cancel HOPE package",
};

const SUBMIT: Record<HopeAction, string> = {
  skip: "Skip window",
  "summary-pdf": "Request summary",
  regenerate: "Create missing windows",
  "cancel-package": "Cancel package",
};

/** The request got no answer (offline, a reset, a timeout): the server may or may not have applied it. */
const ACTION_UNCONFIRMED =
  "Could not confirm that the action was applied. Check the record before trying again.";

export interface HopeActionModalProps {
  readonly open: boolean;
  readonly action: HopeAction;
  /** The subject: a schedule id, assessment id, submission id, admission id or provider-entity id. */
  readonly targetId: string;
  readonly onClose: () => void;
  /**
   * Called after a successful commit so the caller can refresh without guessing at the new state. `value` is what the route answered
   * with (`regenerate`: `{ admissionId, scheduleCount }`, the windows the admission has afterwards), for a caller that says what happened.
   */
  readonly onDone: (value: unknown) => void;
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

  // Reset when the dialog closes as well as when it opens. A caller that keeps this mounted while it is shut would otherwise show
  // the last use's error and chosen reason for the first frame of the next open, before an effect on open cleared them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `open` is the trigger; the effect reads no other reactive value
  useEffect(() => {
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
        // The route's body is the reason code alone (a `note` is refused): the server keeps nothing else on a terminal,
        // HQRP-counted skip, so no Note field is offered here.
        return skipSchedule(client, targetId, {
          reasonCode: reasonCode as (typeof HOPE_SCHEDULE_SKIP_REASON_CODES)[number],
        });
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
      // not re-read (the server's words say to send the request again). Any other 409 is the record having changed. A 404 says
      // the record is gone (or no longer readable by this user), yet the row behind the dialog still offers the action: re-read.
      // An empty 5xx or a fault of the server's own may have been applied after all: re-read what the words say to check.
      const changed = (res.status === 409 && res.code !== RECORD_BUSY_CODE) || res.status === 404;
      if (changed || failedResultOutcomeUnknown(res)) notifyDone(() => onConflict?.());
      return;
    }
    const { value } = res;
    notifyDone(() => onDone(value), onClose);
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
                ...SKIP_REASONS.map((r) => ({ value: r, label: SKIP_REASON_LABEL[r] })),
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
            Creates any HOPE timepoint windows this admission is entitled to and does not have yet.
            Existing windows (open, completed or skipped) are left exactly as they are, so a window
            computed from a wrong date is not moved.
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
