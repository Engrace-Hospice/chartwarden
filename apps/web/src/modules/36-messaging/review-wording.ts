// M36 WP 3.8 - every word the lifecycle review queue shows, in one place. PROVISIONAL pending clinical-lead review (no
// sign-off is recorded): change the text here, never the codes. No patient detail, no cause narrative, no paging language
// beyond the notice that messaging does not page anyone.
import type { ReviewCause, ReviewResolution, TaskCloseReason } from "@wardenx/types";

export const REVIEW_TAB_LABEL = "Review";
export const REVIEW_HEADING = "Lifecycle review";
export const REVIEW_NOTICE =
  "Messaging does not page anyone. Pending handoff items for this patient expire by policy.";
export const REVIEW_LOAD_FAILED = "The review queue could not be loaded. Try again.";
export const RESTRICTED_PATIENT_LABEL = "Restricted patient";
export const RESTRICTED_ROW_TEXT = "Details are not shown to you.";
export const NEEDS_OWNER_LABEL = "Needs new owner";
export const NO_TASK_TEXT = "Task details are not available.";

export const REVIEW_EMPTY: Readonly<Record<"open" | "resolved", string>> = {
  open: "Nothing is waiting for a decision.",
  resolved: "No decisions have been recorded yet.",
};

export const REVIEW_CAUSE_LABELS: Readonly<Record<ReviewCause, string>> = {
  death: "Death",
  discharge: "Discharge",
  transfer: "Transfer",
  care_team_removed: "Removed from the care team",
};

export const REVIEW_RESOLUTION_LABELS: Readonly<Record<ReviewResolution, string>> = {
  reassigned: "Reassigned",
  closed: "Closed",
  closed_elsewhere: "Closed by the task's owner",
};

export const REVIEW_REASON_LABELS: Readonly<Record<TaskCloseReason, string>> = {
  action_taken: "Action taken",
  handled_elsewhere: "Handled elsewhere",
  no_action_needed: "No action needed",
  unable_to_complete: "Unable to complete",
  duplicate: "Duplicate of another task",
};

export const REVIEW_REASON_HINTS: Readonly<Record<TaskCloseReason, string>> = {
  action_taken: "Marks the task done.",
  handled_elsewhere: "Marks the task done.",
  no_action_needed: "Cancels the task.",
  unable_to_complete: "Cancels the task.",
  duplicate: "Cancels the task.",
};

export const REVIEW_ACTION_LABELS = { reassign: "Reassign", close: "Close task" } as const;
export const REASSIGNED_TEXT = "Task reassigned. The review is resolved.";
export const CLOSED_TEXT = "Task closed. The review is resolved.";
export const CHOOSE_ASSIGNEE_TEXT = "Choose who should take this task.";
export const CHOOSE_REASON_TEXT = "Choose a reason before closing this task.";

const FIELD_ERRORS: Readonly<Record<string, string>> = {
  REVIEW_ASSIGNEE_INVALID:
    "That person cannot take this task. Choose someone else who can see the conversation.",
  REVIEW_ITEM_STATE_CONFLICT:
    "This item changed since you opened it. Close this and check its current state.",
};

/** A refusal that means the row on screen is out of date (gone or changed): the list should re-read. */
export const isStaleReviewRefusal = (status: number | undefined): boolean =>
  status === 404 || status === 409;

/** A server refusal as text: the typed code wins, then the HTTP status, then a generic line. */
export function reviewErrorText(status: number | undefined, code: string | undefined): string {
  if (code && FIELD_ERRORS[code]) return FIELD_ERRORS[code];
  if (status === 403) return "You are not allowed to do that.";
  if (status === 404) return "This item is no longer available.";
  return "That did not work. Nothing was changed. Try again.";
}
