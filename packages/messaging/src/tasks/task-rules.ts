// M36 WP 3.4 - the pure communication-task rules. No I/O: the service and the store call these, so the transition table,
// the actor rule, the closing-reason rule and the due window have one definition.
import {
  TASK_ACTIONS,
  TASK_ACTIVE_STATUSES,
  TASK_CLOSE_REASONS,
  TASK_DUE_MAX_DAYS,
  TASK_DUE_PAST_GRACE_MINUTES,
  type TaskAction,
  type TaskStatus,
} from "@wardenx/types";

export { TASK_CLOSE_REASONS };

/** How the caller relates to a task. `both` = creator who assigned it to themselves. */
export type TaskActorRole = "assignee" | "creator" | "both" | "none";

export type TaskTransitionDecision =
  | { readonly kind: "apply"; readonly to: TaskStatus }
  | { readonly kind: "noop" }
  | { readonly kind: "conflict" }
  | { readonly kind: "forbidden" };

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export const isActive = (status: TaskStatus): boolean =>
  (TASK_ACTIVE_STATUSES as readonly string[]).includes(status);

/** The status an action leads to, or null when the action is not legal from `from`. */
export function nextStatus(from: TaskStatus, action: TaskAction): TaskStatus | null {
  if (!isActive(from)) return null;
  switch (action) {
    case "accept":
      return from === "open" ? "accepted" : null;
    case "complete":
      return "done";
    case "cancel":
      return "cancelled";
    case "reassign":
      return "open";
  }
}

export function taskActorRole(
  task: { readonly createdBy: string; readonly assigneeId: string },
  userId: string,
): TaskActorRole {
  const creator = task.createdBy === userId;
  const assignee = task.assigneeId === userId;
  if (creator && assignee) return "both";
  if (assignee) return "assignee";
  return creator ? "creator" : "none";
}

/** Accept and complete are the assignee's; cancel and reassign are the creator's or the assignee's. */
export function canAct(role: TaskActorRole, action: TaskAction): boolean {
  if (role === "none") return false;
  if (action === "accept" || action === "complete") return role !== "creator";
  return true;
}

/**
 * Decide an action against the task's current state. Order matters: who may act is judged first, so a non-participant
 * learns nothing from the state. A repeat of the state the action already produced (accept on accepted, complete on
 * done, cancel on cancelled) is a no-op replay; any other mismatch is a conflict.
 */
export function decideTransition(
  task: { readonly status: TaskStatus },
  action: TaskAction,
  role: TaskActorRole,
): TaskTransitionDecision {
  if (!canAct(role, action)) return { kind: "forbidden" };
  const to = nextStatus(task.status, action);
  if (to) return { kind: "apply", to };
  const replay =
    (action === "accept" && task.status === "accepted") ||
    (action === "complete" && task.status === "done") ||
    (action === "cancel" && task.status === "cancelled");
  return replay ? { kind: "noop" } : { kind: "conflict" };
}

/** A patient task is always clinical, whatever the flag says; a clinical task cannot close without a reason code. */
export function requiresCloseReason(task: {
  readonly patientId: string | null;
  readonly clinicalConcern: boolean;
}): boolean {
  return task.patientId !== null || task.clinicalConcern;
}

/** Null when the due instant is acceptable; otherwise the error code. A due date is optional (null is fine). */
export function validateDue(due: Date | null, now: Date): "TASK_DUE_INVALID" | null {
  if (due === null) return null;
  const t = due.getTime();
  if (Number.isNaN(t)) return "TASK_DUE_INVALID";
  const earliest = now.getTime() - TASK_DUE_PAST_GRACE_MINUTES * MS_PER_MINUTE;
  const latest = now.getTime() + TASK_DUE_MAX_DAYS * MS_PER_DAY;
  return t < earliest || t > latest ? "TASK_DUE_INVALID" : null;
}

const PATIENT_CHANNEL_KINDS: readonly string[] = ["care_team", "bereavement"];

/** The patient is the channel's subject for the two patient channel kinds; every other kind has none. */
export function derivePatient(channelKind: string, subjectId: string | null): string | null {
  return PATIENT_CHANNEL_KINDS.includes(channelKind) ? subjectId : null;
}

/** Display state only: nothing pages or escalates on it. */
export function isOverdue(
  task: { readonly status: TaskStatus; readonly dueAt: Date | null },
  now: Date,
): boolean {
  return isActive(task.status) && task.dueAt !== null && task.dueAt.getTime() < now.getTime();
}

/** The actions `role` may take on a task right now, in a stable order. */
export function allowedActions(
  task: { readonly status: TaskStatus },
  role: TaskActorRole,
): TaskAction[] {
  return TASK_ACTIONS.filter(
    (action) => canAct(role, action) && nextStatus(task.status, action) !== null,
  );
}
