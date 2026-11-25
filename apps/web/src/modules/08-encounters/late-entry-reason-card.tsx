// apps/web/src/modules/08-encounters — the box where the author writes why a note is being entered late (Module 8 §2.5). Shown above the
// "required documentation" card when the note is late, and again, with the reason it still needs, when the server refuses a finalize
// for a missing or short reason. The refusal is worded here (plain language, how late, why) instead of printing the server's sentence.
import { Button, TextAreaField } from "@chartwarden/ui";
import type { CSSProperties, JSX } from "react";
import { useEffect, useRef } from "react";
import {
  LATE_ENTRY_REASON_MAX_CHARS,
  LATE_ENTRY_REASON_MIN_CHARS,
  LATE_ENTRY_WHY,
  type LateEntryEstimate,
  lateEntryApprovalNote,
  lateEntryHowLate,
  lateEntryTierName,
  reasonCountText,
  reasonIsLongEnough,
} from "./late-entry-reason";

const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.65rem",
  padding: "0.9rem 1rem",
  borderRadius: "0.8rem",
  border: "1px solid color-mix(in srgb, var(--color-warning) 35%, transparent)",
  background: "color-mix(in srgb, var(--color-warning) 8%, var(--color-surface))",
};
const title: CSSProperties = { fontSize: "0.83rem", color: "var(--color-on-surface)" };
const text: CSSProperties = {
  margin: 0,
  fontSize: "0.78rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface-variant)",
};
const actions: CSSProperties = { display: "flex", justifyContent: "flex-end" };

export interface LateEntryReasonCardProps {
  readonly serviceDate: string | undefined;
  readonly estimate: LateEntryEstimate | null;
  readonly reason: string;
  readonly onReasonChange: (reason: string) => void;
  /** The server refused the finalize for this reason and it is still too short: the field carries the error. */
  readonly refusedAndShort: boolean;
  /** A finalize or a save is in flight, or the note cannot change. */
  readonly disabled: boolean;
  /** Finalizes the note with the reason that is typed (the composer's own finalize). */
  readonly onFinalize: () => void;
  /** Moves focus to the box each time it grows (the server just refused). */
  readonly focusRequests: number;
}

export function LateEntryReasonCard({
  serviceDate,
  estimate,
  reason,
  onReasonChange,
  refusedAndShort,
  disabled,
  onFinalize,
  focusRequests,
}: LateEntryReasonCardProps): JSX.Element {
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusRequests === 0) return;
    box.current?.scrollIntoView?.({ block: "center" });
    box.current?.querySelector("textarea")?.focus();
  }, [focusRequests]);

  const howLate = lateEntryHowLate(serviceDate, estimate);
  const tierName = lateEntryTierName(estimate);
  const approval = lateEntryApprovalNote(estimate);
  return (
    <section ref={box} style={card} aria-label="Late entry">
      <strong style={title}>This note is being entered late</strong>
      <p style={text}>
        {[howLate, tierName ? `It counts as ${tierName}.` : ""].filter(Boolean).join(" ")}
        {howLate || tierName ? " " : ""}
        {LATE_ENTRY_WHY}
      </p>
      {approval ? <p style={text}>{approval}</p> : null}
      <TextAreaField
        label="Reason for the late entry"
        required
        rows={3}
        maxLength={LATE_ENTRY_REASON_MAX_CHARS}
        value={reason}
        onChange={(event) => onReasonChange(event.target.value)}
        disabled={disabled}
        hint={`Say why the note was not documented sooner. At least ${LATE_ENTRY_REASON_MIN_CHARS} characters: ${reasonCountText(reason)}.`}
        error={
          refusedAndShort
            ? `A reason of at least ${LATE_ENTRY_REASON_MIN_CHARS} characters is needed before this note can be finalized.`
            : undefined
        }
      />
      <div style={actions}>
        <Button onClick={onFinalize} disabled={disabled || !reasonIsLongEnough(reason)}>
          Finalize with this reason
        </Button>
      </div>
    </section>
  );
}
