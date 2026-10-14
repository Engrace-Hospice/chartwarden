// M36 WP 3.5 - every word the handoff UI shows, in one place. PROVISIONAL pending clinical-lead review (no sign-off is
// recorded): change the text here, never the codes. Handoffs never page anyone; the notices below say so plainly.
import type { HandoffItemKind, HandoffItemState, HandoffState } from "@wardenx/types";

export const HANDOFF_NOTICE =
  "Handoffs do not page anyone. Until the receiver accepts an item, you stay responsible for it.";
export const HANDOFFS_LOAD_FAILED = "Handoffs could not be loaded. Try again.";
export const NEEDS_ATTENTION_LABEL = "Needs attention";
export const CALLBACKS_NOT_INCLUDED = "Callbacks are not included in this version.";
export const CASELOAD_UNAVAILABLE =
  "Your caseload could not be loaded, so a handoff cannot be started now.";
export const NO_CASELOAD_TEXT = "You have no patients on your caseload to hand off.";
export const CHOOSE_PATIENTS_TEXT = "Choose at least one patient.";
export const CHOOSE_ITEMS_TEXT = "Keep at least one item to hand off.";
export const CHOOSE_RECIPIENT_TEXT = "Choose who this handoff is for.";
export const CHOOSE_ACCEPT_TEXT = "Choose at least one item to accept.";
export const PATIENT_CAP_TEXT = "You can hand off up to 50 patients at once.";
export const RESTRICTED_PATIENT_LABEL = "Restricted patient";
export const UNKNOWN_PERSON = "a colleague";

export const HANDOFF_STATE_LABELS: Readonly<Record<HandoffState, string>> = {
  offered: "Offered",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  cancelled: "Cancelled",
};

export const ITEM_STATE_LABELS: Readonly<Record<HandoffItemState, string>> = {
  pending: "Waiting",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  cancelled: "Withdrawn",
};

export const ITEM_KIND_LABELS: Readonly<Record<HandoffItemKind, string>> = {
  patient: "Patient",
  visit: "Next visit",
  refill_request: "Refill request",
  symptom_followup: "Symptom follow-up",
  task: "Task",
};

/** Shown when a source could not be read; the items of that kind are simply not offered. */
export const UNAVAILABLE_SOURCE_TEXT: Readonly<Record<HandoffItemKind, string>> = {
  patient: "Patients could not be loaded and are not included.",
  visit: "Visits could not be loaded and are not included.",
  refill_request: "Refill requests could not be loaded and are not included.",
  symptom_followup: "Symptom follow-ups could not be loaded and are not included.",
  task: "Tasks could not be loaded and are not included.",
};

/** Item summaries that carry no data: fixed wording, never a reason (a restricted item reveals nothing). */
export const SUMMARY_TEXT = {
  gone: "No longer available",
  unavailable: "Status could not be loaded",
  restricted: "Details are not shown to you",
  closedOut: "No longer open",
} as const;

export const expirySentence = (minutes: number): string =>
  minutes % 60 === 0
    ? `If not accepted within ${minutes / 60} ${minutes === 60 ? "hour" : "hours"}, these patients stay with you and a supervisor is alerted.`
    : `If not accepted within ${minutes} minutes, these patients stay with you and a supervisor is alerted.`;

/** "in 2h 5m" / "in 12m" / "Past due" from an instant; coarse on purpose. */
export function expiresText(iso: string, now: number = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  if (Number.isNaN(diff)) return "";
  if (diff <= 0) return "Past due";
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `Expires in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `Expires in ${hours}h` : `Expires in ${hours}h ${rest}m`;
}

const RECIPIENT_TEXT =
  "That person cannot receive this handoff. Choose someone else, or check with your supervisor.";
const ITEMS_TEXT = "Some items can no longer be handed off. Review the list and try again.";

const FIELD_ERRORS: Readonly<Record<string, string>> = {
  HANDOFF_RECIPIENT_INVALID: RECIPIENT_TEXT,
  HANDOFF_ITEM_INVALID: ITEMS_TEXT,
  HANDOFF_ITEMS_REQUIRED: CHOOSE_ITEMS_TEXT,
  HANDOFF_TOO_MANY_ITEMS: "That is too many items for one handoff. Remove some or split it.",
  HANDOFF_ITEM_NOT_TRANSFERABLE:
    "One of the selected tasks cannot be moved to you. Clear that selection and try again.",
  HANDOFF_ITEM_CONFLICT: "One or more items are already part of another open handoff.",
  HANDOFF_STATE_CONFLICT: "This handoff changed since you opened it. It has been refreshed.",
  HANDOFF_POLICY_INVALID: "Choose a whole number of minutes within the allowed range.",
};

/** A refusal that means the screen is out of date (gone or changed): reload. */
export const isStaleRefusal = (status: number | undefined): boolean =>
  status === 404 || status === 409;

/** A server refusal as text: the typed code wins, then the status, then a generic line. Never echoes server text. */
export function handoffErrorText(status: number | undefined, code: string | undefined): string {
  if (code && FIELD_ERRORS[code]) return FIELD_ERRORS[code];
  if (status === 403) return "You are not allowed to do that to this handoff.";
  if (status === 404) return "This handoff is no longer available.";
  return "That did not work. Nothing was changed. Try again.";
}
