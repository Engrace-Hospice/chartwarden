// apps/web/src/modules/10-hope — the "Past the late deadline" part of the recording dialog: the administrative override and the
// justification it must carry (split from the dialog, which is about the clinical form). The override's STATE lives in the dialog,
// because the request it builds and its reset read it; what is judged from that state, and what is drawn, live here.
import { StatusPill, TextAreaField } from "@chartwarden/ui";
import type { JSX } from "react";
import { checkRow, lateBox, meta } from "./hope-dialog-styles";
import {
  JUSTIFICATION_REFUSAL_WORDS,
  type JustificationRefusal,
  OVERRIDE_JUSTIFICATION_MAX,
  OVERRIDE_JUSTIFICATION_MIN,
  hasForbiddenJustificationCharacter,
  justificationLengthOk,
} from "./hope-override-justification";

/**
 * The permission the server requires for `adminOverride` (hope-routes.ts `ADMIN_LATE_OVERRIDE`): a request that asks for the override
 * without it is refused 403, after the clinician has typed a justification. A session known to lack it is not offered the control.
 */
export const OVERRIDE_PERMISSION = "hope.admin.late_deadline_override";
/**
 * What a clinician who cannot tick the override is told: only what is certain. Who else could record the visit is not (recording
 * needs the author discipline of the recorder's OWN roles, and files the visit under the recorder), so nobody is named to do it: the
 * administrator decides how it is to be recorded.
 */
const OVERRIDE_NOT_PERMITTED =
  "Only an administrator with override permission can override the late deadline. Ask your administrator how this visit should be recorded.";
/** What the refusal M10_TIMEPOINT_EXPIRED says to a clinician who cannot tick the override (instead of telling them to). */
export const OVERRIDE_NOT_PERMITTED_ASKED =
  "This visit is past the late deadline, so recording it needs an administrative override. Only an administrator with override permission can give one: ask your administrator how this visit should be recorded.";

const JUSTIFICATION_HINT = `Between ${OVERRIDE_JUSTIFICATION_MIN} and ${OVERRIDE_JUSTIFICATION_MAX} characters (a run of spaces or line breaks counts as one). It is recorded in the audit trail when the override is used and cannot be changed later, so do not enter a patient's name or a Social Security or Medicare number.`;

/** What the dialog holds of the override: the tick, the text as typed, and what the server's last refusal said about it. */
export interface OverrideState {
  readonly checked: boolean;
  readonly text: string;
  readonly refusal: JustificationRefusal | null;
}

export interface OverrideJudgement {
  /** The override is in force for the request: past the late deadline, ticked, and the session may tick it. */
  readonly overriding: boolean;
  /** The text to send: trimmed, never collapsed. */
  readonly justification: string;
  /** The static words for the field, or undefined: the server's last refusal, else what the server would refuse. */
  readonly error: string | undefined;
  /** The override alone keeps the dialog from sending: a justification the server would refuse. */
  readonly blocked: boolean;
}

/**
 * The override only exists past the late deadline: the checkbox is only offered there, so a tick left over from another date is not
 * sent, and cannot block a capture whose justification box is not on screen. What the server refuses is refused here first: a pasted
 * zero-width space passes the length minimum but never the server.
 */
export function judgeOverride(
  state: OverrideState,
  expired: boolean,
  canOverride: boolean,
): OverrideJudgement {
  const overriding = expired && state.checked && canOverride;
  const justification = state.text.trim();
  const invisible = overriding && hasForbiddenJustificationCharacter(justification);
  const error =
    state.refusal !== null
      ? JUSTIFICATION_REFUSAL_WORDS[state.refusal]
      : invisible
        ? JUSTIFICATION_REFUSAL_WORDS.invalid_characters
        : undefined;
  return {
    overriding,
    justification,
    error,
    blocked: overriding && (!justificationLengthOk(justification) || invisible),
  };
}

export interface HopeOverrideSectionProps {
  readonly canOverride: boolean;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly text: string;
  readonly onTextChange: (text: string) => void;
  /** The textarea's id, so the dialog can move focus to it after a refusal. */
  readonly fieldId: string;
  readonly error: string | undefined;
}

export function HopeOverrideSection({
  canOverride,
  checked,
  onCheckedChange,
  text,
  onTextChange,
  fieldId,
  error,
}: HopeOverrideSectionProps): JSX.Element {
  return (
    <div style={lateBox}>
      <StatusPill label="Past the late deadline" tone="error" />
      <p style={meta}>
        The window's late deadline has passed. Recording now requires an administrative override,
        which the server records on the row; the late-completion reason is filed as "Admin
        Override".
      </p>
      {canOverride ? (
        <label style={checkRow}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onCheckedChange(e.target.checked)}
          />
          <span>Record with administrative override</span>
        </label>
      ) : (
        <p style={meta}>{OVERRIDE_NOT_PERMITTED}</p>
      )}
      {canOverride && checked ? (
        <TextAreaField
          id={fieldId}
          label="Justification for the override"
          hint={JUSTIFICATION_HINT}
          error={error}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          maxLength={OVERRIDE_JUSTIFICATION_MAX}
          rows={3}
        />
      ) : null}
    </div>
  );
}
