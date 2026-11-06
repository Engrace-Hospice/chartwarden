// @chartwarden/ui web — ReasonDialog: the one prompt every platform write goes through (say why, then confirm).
//
// - It judges the reason the way the server does (`checkReason`: whitespace collapsed, control characters removed, then counted) and
//   hands `onConfirm` the NORMALISED text, so what the operator reviewed is what is recorded.
// - It says where the reason goes: the audit trail the TENANT can read. Use a ticket reference; no patient information.
// - A refusal the server gave stays on screen with the typed reason (`error`, or `fieldError` on the reason box itself).
// - A PINNED action (an If-Match on a record the operator read) passes `record`, the facts being acted on; when the record changed
//   since it was read it passes `stale`, which says so and re-words the confirm button. The caller re-reads the record and passes the
//   fresh one; nothing is retried on the operator's behalf.
import { useEffect, useId, useState } from "react";
import type { JSX, ReactNode } from "react";
import { type ReasonRule, checkReason, normalizeReason } from "../../core/ops-write/reason";
import { Modal } from "../system/modal";
import { Button } from "./button";
import { TextAreaField } from "./fields";
import { InlineAlert } from "./inline-alert";

export interface ReasonDialogRecordLine {
  readonly label: string;
  readonly value: ReactNode;
}

export interface ReasonDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: ReactNode;
  readonly rule: ReasonRule;
  readonly confirmLabel: string;
  readonly tone?: "primary" | "danger";
  readonly busy?: boolean;
  /** The server's refusal, shown above the actions. */
  readonly error?: ReactNode;
  /** The server's field error for the reason itself (a patient-identifier refusal). */
  readonly fieldError?: string;
  /** The record being acted on (a pinned action). */
  readonly record?: readonly ReasonDialogRecordLine[];
  /** The record changed since the operator read it. */
  readonly stale?: boolean;
  /** Replaces the default reason label. */
  readonly reasonLabel?: string;
  readonly onConfirm: (reason: string) => void;
  readonly onCancel: () => void;
}

export function ReasonDialog({
  open,
  title,
  description,
  rule,
  confirmLabel,
  tone = "primary",
  busy = false,
  error,
  fieldError,
  record,
  stale = false,
  reasonLabel = "Reason",
  onConfirm,
  onCancel,
}: ReasonDialogProps): JSX.Element | null {
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const descriptionId = useId();
  // A dialog that stays mounted must not show the last attempt's reason the next time it opens.
  useEffect(() => {
    if (!open) {
      setReason("");
      setProblem(null);
    }
  }, [open]);
  if (!open) return null;

  function submit(): void {
    const issue = checkReason(reason, rule);
    setProblem(issue);
    if (issue === null) onConfirm(normalizeReason(reason));
  }

  return (
    <Modal
      open
      ariaLabel={title}
      width="30rem"
      onClose={busy ? undefined : onCancel}
      dismissOnScrim={false}
      ariaDescribedBy={description ? descriptionId : undefined}
    >
      <div className="wx-modal-body">
        <h2>{title}</h2>
        {description ? <p id={descriptionId}>{description}</p> : null}
        {stale ? (
          <InlineAlert tone="warning">
            This record changed since you opened it. Review what it says now, then confirm again.
          </InlineAlert>
        ) : null}
        {record && record.length > 0 ? (
          <dl className="wx-kv">
            {record.map((line) => (
              <div key={line.label}>
                <dt>{line.label}</dt>
                <dd>{line.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <TextAreaField
          label={reasonLabel}
          hint="Recorded in the audit trail and visible to the tenant. Use a ticket reference; no patient information."
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={problem ?? fieldError}
        />
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <div className="wx-modal-actions">
          <Button tone="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button tone={tone} onClick={submit} disabled={busy}>
            {busy
              ? "Working…"
              : stale
                ? `Confirm the updated record: ${confirmLabel}`
                : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
