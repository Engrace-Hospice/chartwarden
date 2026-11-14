// apps/web/src/modules/34-saas/wizard — the written reason a tenant gives when it skips a step or re-opens one, judged the way the server
// judges it (whitespace collapsed, control characters removed, then counted) and handed to `onConfirm` NORMALISED. The kit's ReasonDialog
// is worded for an operator writing to a tenant; this one is the tenant's own, so it says only where the words go and that no patient
// information belongs in them. A refusal stays on screen with the typed reason; a Re-verify keeps it (the parent stashes it in memory).
import {
  Button,
  Modal,
  type ReasonRule,
  TextAreaField,
  checkReason,
  normalizeReason,
} from "@chartwarden/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

export function ReasonPrompt({
  open,
  title,
  description,
  rule,
  label,
  confirmLabel,
  busy,
  error,
  fieldError,
  initialReason,
  onReasonChange,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  rule: ReasonRule;
  label: string;
  confirmLabel: string;
  busy: boolean;
  /** The server's refusal as a node that brings its own alert (a FailureNotice). */
  error?: ReactNode;
  /** The server's field error for the text itself (a patient-identifier refusal). */
  fieldError?: string | undefined;
  /** What the box starts with when the prompt opens (a reason kept across a Re-verify). */
  initialReason?: string | undefined;
  /** Every change to the typed text, so a Re-verify keeps an edit made after a refusal and not only the last submitted one. */
  onReasonChange: (reason: string) => void;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}): JSX.Element | null {
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const descriptionId = useId();
  // Seeded when the prompt opens, never overwritten while the person types.
  const initialRef = useRef(initialReason);
  initialRef.current = initialReason;
  useEffect(() => {
    setReason(open ? (initialRef.current ?? "") : "");
    setProblem(null);
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
      ariaDescribedBy={descriptionId}
    >
      <div className="wx-modal-body">
        <h2>{title}</h2>
        <p id={descriptionId}>{description}</p>
        <TextAreaField
          label={label}
          hint="Your organization keeps this in its audit trail. Do not include patient information."
          rows={3}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            onReasonChange(e.target.value);
          }}
          error={problem ?? fieldError}
        />
        {error ? <div>{error}</div> : null}
        <div className="wx-modal-actions">
          <Button tone="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
