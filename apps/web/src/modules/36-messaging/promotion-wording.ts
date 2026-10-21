// M36 WP 3.7 - every word the chart-proposal UI shows, in one place. PROVISIONAL pending clinical-lead review (no
// sign-off is recorded): change the text here, never the codes. A proposal never copies message text and never changes
// the chart; the notices below say so plainly.
import type { ChartPromotionStatus } from "@chartwarden/types";

export const PROPOSE_BUTTON_LABEL = "Propose for chart";
export const PROPOSE_DIALOG_TITLE = "Propose for the chart";
export const PROMOTION_NOTICE =
  "This only asks a clinician to review the message. Nothing enters the chart until they decide, and no text is copied. Orders cannot be created from messages.";
export const TARGET_LEGEND = "Where should it be reviewed?";
export const TARGET_LABELS = {
  m8: "Encounter addendum (a clinician reviews it and writes and signs their own addendum)",
  m14: "IDG agenda item (the IDG coordinator decides whether to add it)",
} as const;
export const CHOOSE_TARGET_TEXT = "Choose where this should be reviewed.";
export const PROPOSALS_LOAD_FAILED = "Chart proposals could not be loaded. Try again.";
export const PROPOSALS_HEADING = "Chart proposals";
export const PROPOSALS_EMPTY = {
  active: "You have no open chart proposals.",
  closed: "You have no closed chart proposals.",
} as const;
export const WITHDRAW_LABEL = "Withdraw proposal";
export const PROPOSED_OK_TEXT = "Proposal sent for review. Nothing has changed in the chart.";
export const PROPOSED_REPLAY_TEXT = "That message was already proposed there. It was not changed.";
export const WITHDRAWN_TEXT = "Proposal withdrawn.";
export const UNKNOWN_PERSON = "a colleague";

export const PROMOTION_STATUS_LABELS: Readonly<Record<ChartPromotionStatus, string>> = {
  proposed: "Proposed",
  accepted: "Accepted by reviewer",
  rejected: "Declined by reviewer",
  superseded: "Replaced",
  withdrawn: "Withdrawn",
};

export const PROMOTION_TARGET_SHORT = { m8: "Encounter addendum", m14: "IDG agenda" } as const;

const CODE_ERRORS: Readonly<Record<string, string>> = {
  PROMOTION_TARGET_INVALID: "That place is not available for chart proposals.",
  PROMOTION_SOURCE_NOT_PATIENT_LINKED:
    "Only messages in a patient's care-team conversation can be proposed for the chart.",
  PROMOTION_SUGGESTED_REF_INVALID: "That suggested record is not available.",
  PROMOTION_STATE_CONFLICT: "This proposal changed since you opened it. It has been refreshed.",
};

export const PROMOTION_GONE_TEXT = "This proposal or message is no longer available.";

/** A refusal that means the screen is out of date: re-read. */
export const isStaleRefusal = (status: number | undefined): boolean =>
  status === 403 || status === 404 || status === 409;

/** A server refusal as text: the typed code wins, then the status, then a generic line. Never echoes server text. */
export function promotionErrorText(status: number | undefined, code: string | undefined): string {
  if (code && CODE_ERRORS[code]) return CODE_ERRORS[code];
  if (status === 403) return "You are not allowed to do that.";
  if (status === 404) return PROMOTION_GONE_TEXT;
  return "That did not work. Nothing was changed. Try again.";
}
