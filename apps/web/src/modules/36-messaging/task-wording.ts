// M36 WP 3.4 - every word the task UI shows, in one place. PROVISIONAL pending clinical-lead review (no sign-off is
// recorded): change the text here, never the codes. Deliberately free of urgency and escalation language; the only
// mention of paging is the notice that tasks do not do it.
import type { TaskAction, TaskCloseReason, TaskStatus } from "@wardenx/types";

export const TASK_NOTICE =
  "Tasks do not page or escalate anyone and are not for emergencies. Use your emergency process for urgent needs.";
export const TASKS_OFF_TEXT = "Tasks are not turned on for your organization.";
export const TASKS_LOAD_FAILED = "Tasks could not be loaded. Try again.";
export const NEEDS_OWNER_LABEL = "Needs new owner";
export const PATIENT_TASK_LABEL = "Patient task";
export const OVERDUE_LABEL = "Overdue";
export const CLINICAL_CONCERN_LABEL = "Clinical concern (needs a closing reason)";

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  open: "Open",
  accepted: "Accepted",
  done: "Done",
  cancelled: "Cancelled",
};

export const TASK_ACTION_LABELS: Readonly<Record<TaskAction, string>> = {
  accept: "Accept",
  complete: "Complete",
  cancel: "Cancel",
  reassign: "Reassign",
};

export const TASK_CLOSE_REASON_LABELS: Readonly<Record<TaskCloseReason, string>> = {
  action_taken: "Action taken",
  handled_elsewhere: "Handled elsewhere",
  no_action_needed: "No action needed",
  unable_to_complete: "Unable to complete",
  duplicate: "Duplicate of another task",
};

export const CHOOSE_ASSIGNEE_TEXT = "Choose who this task is for.";
export const CHOOSE_REASON_TEXT = "Choose a reason before closing this clinical task.";

const FIELD_ERRORS: Readonly<Record<string, string>> = {
  TASK_ASSIGNEE_INVALID:
    "That person cannot be given this task. Choose someone else in the conversation.",
  TASK_ASSIGNEE_ALREADY_HAS_ACTIVE: "That person already has an active task on this message.",
  TASK_DUE_INVALID: "Choose a due date from today onward, within the next year.",
  TASK_CLOSE_REASON_REQUIRED: CHOOSE_REASON_TEXT,
  TASK_CLOSE_REASON_INVALID: "That reason is not available. Choose one from the list.",
  TASK_STATE_CONFLICT:
    "This task changed since you opened it. Close this and check its current state.",
};

/** A refusal that means the row on screen is out of date (gone or changed): the list should re-read. */
export const isStaleRefusal = (status: number | undefined): boolean =>
  status === 404 || status === 409;

/** A server refusal as text: the typed code wins, then the HTTP status, then a generic line. */
export function taskErrorText(status: number | undefined, code: string | undefined): string {
  if (code && FIELD_ERRORS[code]) return FIELD_ERRORS[code];
  if (status === 403) return "You are not allowed to do that to this task.";
  if (status === 404) return "This task or message is no longer available.";
  return "That did not work. Nothing was changed. Try again.";
}
