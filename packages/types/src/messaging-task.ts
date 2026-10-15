// M36 WP 3.4 - communication tasks: a thin row that points at ONE message and names an assignee. Ids, enums and
// instants only: no title, no message excerpt, no free text (the message is read through the conversation, so a task
// is never a second PHI store). The closing reason is a CODE; its labels are provisional wording owned by the UI.

export const TASK_STATUSES = ["open", "accepted", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A task still needing work. The idempotency index (one per message and assignee) covers exactly these. */
export const TASK_ACTIVE_STATUSES = ["open", "accepted"] as const;

export const TASK_CLOSED_STATUSES = ["done", "cancelled"] as const;

export const TASK_ACTIONS = ["accept", "complete", "cancel", "reassign"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export const TASK_CLOSE_REASONS = [
  "action_taken",
  "handled_elsewhere",
  "no_action_needed",
  "unable_to_complete",
  "duplicate",
] as const;
export type TaskCloseReason = (typeof TASK_CLOSE_REASONS)[number];

export const TASK_EVENT_TYPES = [
  "created",
  "accepted",
  "done",
  "cancelled",
  "reassigned",
  "needs_owner",
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export const TASK_ACTOR_KINDS = ["user", "system"] as const;
export type TaskActorKind = (typeof TASK_ACTOR_KINDS)[number];

/**
 * Why an assignee changed: a person did it, offboarding did, or the task moved with an accepted handoff item (WP 3.5).
 * Stored as the `reassigned` event's reason code.
 */
export const TASK_REASSIGN_SOURCES = ["manual", "offboarding", "handoff", "review"] as const;
export type TaskReassignSource = (typeof TASK_REASSIGN_SOURCES)[number];

/** The window a due instant may fall in, relative to now (a short grace for clock skew, then a year). */
export const TASK_DUE_PAST_GRACE_MINUTES = 5;
export const TASK_DUE_MAX_DAYS = 366;

export interface TaskDto {
  readonly id: string;
  readonly message_id: string;
  readonly channel_id: string;
  readonly patient_id: string | null;
  readonly created_by: string;
  readonly assignee_id: string;
  readonly assignee_display_name: string | null;
  readonly created_by_display_name: string | null;
  readonly due_at: string | null;
  readonly status: TaskStatus;
  readonly clinical_concern: boolean;
  readonly closed_reason: TaskCloseReason | null;
  readonly needs_owner: boolean;
  /** Display state only: past due and still active. Nothing escalates on it. */
  readonly overdue: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  /** The actions the caller may take now, computed server-side so the web never re-derives policy. */
  readonly allowed_actions: readonly TaskAction[];
}

export interface TaskEventDto {
  readonly id: string;
  readonly task_id: string;
  readonly event_type: TaskEventType;
  readonly actor_kind: TaskActorKind;
  readonly actor_user_id: string | null;
  readonly from_status: TaskStatus | null;
  readonly to_status: TaskStatus | null;
  readonly from_assignee_id: string | null;
  readonly to_assignee_id: string | null;
  readonly reason_code: string | null;
  readonly created_at: string;
}
