import type { EncounterVisitModality } from "@chartwarden/types";
import { t } from "@chartwarden/ui";
import type { CSSProperties, FocusEvent, JSX } from "react";
import { useId, useState } from "react";
import {
  type DeliveryDraft,
  type DeliveryRuleContext,
  MODALITY_OPTIONS,
  deviceTimeZone,
  modalityLabel,
  requiresModality,
  timeProblem,
} from "./visit-delivery";

interface VisitDeliveryFieldsProps {
  readonly draft: DeliveryDraft;
  readonly context: DeliveryRuleContext;
  /** The scheduler's unconfirmed guess, shown as a hint only: it is never selected for the clinician. */
  readonly scheduledAs?: EncounterVisitModality | null;
  readonly onChange: (next: DeliveryDraft) => void;
}

/**
 * The sign ceremony's delivery step: how the visit was delivered (a required, ACTIVE choice for the disciplines
 * Medicare counts; a scheduled guess is only a hint) and, only when no EVV bracket exists, the ACTUAL documented
 * start and end times. Presentational: the rules live in ./visit-delivery.
 */
export function VisitDeliveryFields({
  draft,
  context,
  scheduledAs = null,
  onChange,
}: VisitDeliveryFieldsProps): JSX.Element {
  const baseId = useId();
  const modalityHelpId = `${baseId}-modality-help`;
  const timeHelpId = `${baseId}-time-help`;
  const timeProblemId = `${baseId}-time-problem`;
  // The both-times message would otherwise fire the moment the first field is filled; wait until a time field has
  // been left (this component unmounts with the ceremony, so it starts untouched on every open).
  const [timesTouched, setTimesTouched] = useState(false);
  const asksModality = requiresModality(context.discipline);
  const issue = timeProblem(draft, context);
  const bothTyped = draft.startedAt !== "" && draft.endedAt !== "";
  const shownIssue = issue !== null && (timesTouched || bothTyped) ? issue : null;
  const timeAria = {
    "aria-invalid": shownIssue !== null ? true : undefined,
    "aria-describedby": shownIssue !== null ? timeProblemId : timeHelpId,
  } as const;
  // "Touched" means focus LEFT the start/end pair with something typed: moving from the start field to the end field,
  // or tabbing through two empty fields, must not raise the both-times alert.
  const onPairBlur = (event: FocusEvent<HTMLFieldSetElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (draft.startedAt !== "" || draft.endedAt !== "") setTimesTouched(true);
  };

  return (
    <div style={wrapStyle}>
      {asksModality ? (
        <fieldset style={fieldsetStyle} aria-describedby={modalityHelpId}>
          <legend style={legendStyle}>How was this visit delivered?</legend>
          <div style={optionRowStyle}>
            {MODALITY_OPTIONS.map((option) => (
              <label key={option.value} style={optionStyle}>
                <input
                  type="radio"
                  name={`${baseId}-modality`}
                  value={option.value}
                  required
                  checked={draft.modality === option.value}
                  onChange={() => onChange({ ...draft, modality: option.value })}
                />
                {option.label}
              </label>
            ))}
          </div>
          <span id={modalityHelpId} style={helpStyle}>
            {scheduledAs !== null
              ? `Scheduled as: ${modalityLabel(scheduledAs)} (not yet confirmed). Choose how the visit was actually delivered. `
              : ""}
            Required before you can sign.
          </span>
        </fieldset>
      ) : null}

      {context.evvBracketPresent ? (
        <span style={helpStyle}>
          Start and end times come from the electronic visit verification (EVV) record.
        </span>
      ) : (
        <fieldset style={fieldsetStyle} onBlur={onPairBlur}>
          <legend style={legendStyle}>Visit times (optional)</legend>
          <div style={optionRowStyle}>
            <label style={timeFieldStyle}>
              <span style={timeLabelStyle}>Start time</span>
              <input
                type="datetime-local"
                value={draft.startedAt}
                onChange={(event) => onChange({ ...draft, startedAt: event.target.value })}
                style={timeInputStyle}
                {...timeAria}
              />
            </label>
            <label style={timeFieldStyle}>
              <span style={timeLabelStyle}>End time</span>
              <input
                type="datetime-local"
                value={draft.endedAt}
                onChange={(event) => onChange({ ...draft, endedAt: event.target.value })}
                style={timeInputStyle}
                {...timeAria}
              />
            </label>
          </div>
          <span id={timeHelpId} style={helpStyle}>
            Enter the actual start and end times of the visit as you documented them, in this
            device's time zone ({deviceTimeZone()}). Leave both blank if you did not record them;
            times are never estimated or filled in for you.
          </span>
          {shownIssue !== null ? (
            <span id={timeProblemId} role="alert" style={problemStyle}>
              {shownIssue}
            </span>
          ) : null}
        </fieldset>
      )}
    </div>
  );
}

const wrapStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.75rem" };
const fieldsetStyle: CSSProperties = {
  border: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
  minWidth: 0,
};
const legendStyle: CSSProperties = {
  padding: 0,
  fontSize: "0.8rem",
  fontWeight: 650,
  color: t.onSurface,
};
const optionRowStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "0.9rem" };
const optionStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  fontSize: "0.85rem",
  color: t.onSurface,
  cursor: "pointer",
};
const timeFieldStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.25rem" };
const timeLabelStyle: CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 650,
  color: t.onSurfaceVariant,
};
const timeInputStyle: CSSProperties = {
  minHeight: "2.25rem",
  padding: "0.35rem 0.5rem",
  borderRadius: t.radiusMd,
  border: `1px solid ${t.outlineVariant}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  fontSize: "0.85rem",
};
const helpStyle: CSSProperties = {
  fontSize: "0.72rem",
  lineHeight: 1.4,
  color: t.onSurfaceVariant,
};
const problemStyle: CSSProperties = { fontSize: "0.75rem", color: t.error };
