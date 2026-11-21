// apps/web/src/modules/08-encounters/review — the late-entry reason input (WF09 WP3). A note documented more than 1 calendar day after the
// visit date (late-entry/tiers.ts counts whole days from the service date) is refused at finalize (422 LATE_ENTRY_REASON_REQUIRED) until
// it carries the author's own reason, at least 40 characters. No screen sent one, so the blocker's remedy led nowhere. The server decides
// the tier and whether a reason is needed; this only collects the text. Finalize is the only step that sends it: the sign dialog does not.
import { TextAreaField } from "@chartwarden/ui";
import { type JSX, useState } from "react";

/** The server's minimum for the reason (`FinalizeEncounterSchema`, `TEXT_MINIMUMS.lateEntryReason`), counted after trimming. */
export const LATE_ENTRY_REASON_MIN = 40;
const LATE_ENTRY_REASON_MAX = 4000;

export const LATE_ENTRY_REASON_FIELD_ID = "visit-late-entry-reason";

/** The reason to send with a finalize: the trimmed text once it is long enough, else nothing (the server then says whether one was needed). */
export function lateEntryReasonToSend(value: string): string | undefined {
  const reason = value.trim();
  return reason.length >= LATE_ENTRY_REASON_MIN ? reason : undefined;
}

/** Move focus to the field, for a blocker's remedy. False when it is not on the page. */
export function focusLateEntryReason(): boolean {
  const field = document.getElementById(LATE_ENTRY_REASON_FIELD_ID);
  if (field === null) return false;
  field.focus();
  return true;
}

interface LateEntryReasonFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}

export function LateEntryReasonField({
  value,
  onChange,
  disabled = false,
}: LateEntryReasonFieldProps): JSX.Element {
  // The kit announces an error as an alert on every change of its text, so the error is static and shows once the author has left the field
  // (leaving it to press Finalize counts); the running count is in the hint, which is read on arrival and not announced as it changes.
  const [left, setLeft] = useState(false);
  const typed = value.trim().length;
  const tooShort = typed < LATE_ENTRY_REASON_MIN;
  const count = typed > 0 ? ` (${typed} so far)` : "";
  return (
    <TextAreaField
      id={LATE_ENTRY_REASON_FIELD_ID}
      label="Late-entry reason"
      hint={`Required when a note is documented more than 1 calendar day after the visit date. At least ${LATE_ENTRY_REASON_MIN} characters${count}.`}
      error={left && tooShort ? `Enter at least ${LATE_ENTRY_REASON_MIN} characters.` : undefined}
      value={value}
      maxLength={LATE_ENTRY_REASON_MAX}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => setLeft(true)}
    />
  );
}
