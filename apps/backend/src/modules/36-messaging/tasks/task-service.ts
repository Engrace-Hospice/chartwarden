// apps/backend/src/modules/36-messaging/tasks/task-service.ts - WP 3.4: the communication-task policy.
//
// A task is a thin pointer at one message plus an assignee (ADR-0061). This service owns the rules the routes must not
// re-derive: only the creator or the assignee sees a task; a task never shows a message to someone who could not read
// it (assignee eligibility, and visibility re-checked on every read and act); the patient is derived from the channel,
// never taken from the client; a clinical task cannot close without a reason code. It is flag-independent - the routes
// gate the `messaging.tasks` flag. It never touches M14: IDG action items are not messages (see m36-task-no-idg test).
import type { DbClient } from "@wardenx/db";
import {
  TASK_CLOSE_REASONS,
  allowedActions,
  decideTransition,
  derivePatient,
  isOverdue,
  requiresCloseReason,
  taskActorRole,
  validateDue,
} from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import {
  ForbiddenError,
  NotFoundError,
  type TaskAction,
  type TaskCloseReason,
  type TaskDto,
  type TaskEventDto,
  type TaskEventType,
  type TaskSourceKind,
  type TaskStatus,
  WardenXError,
} from "@wardenx/types";
import type { HintOutboxPort } from "../message-hint-events";
import { publishTaskEvent } from "./task-events";
import {
  TaskAssigneeAlreadyHasActive,
  type TaskEventRow,
  type TaskListQuery,
  TaskNotFound,
  type TaskRow,
  TaskStateConflict,
  type TaskStore,
  createDbTaskStore,
} from "./task-store-db";

export const TASKS_FLAG_KEY = "messaging.tasks";

export interface TaskActorRef {
  readonly orgId: string;
  readonly userId: string;
}

export interface MessageFacts {
  readonly live: boolean;
  /** The channel is archived (discharge, death, transfer): no new task may point into it (WP 3.8). */
  readonly archived?: boolean;
  readonly channelKind: string;
  readonly subjectId: string | null;
}

export interface TaskService {
  convert(
    actor: TaskActorRef,
    a: {
      channelId: string;
      messageId: string;
      assigneeUserId: string;
      dueAt?: Date | null;
      clinicalConcern?: boolean;
    },
  ): Promise<{ task: TaskDto; created: boolean }>;
  get(actor: TaskActorRef, taskId: string): Promise<{ task: TaskDto; events: TaskEventDto[] }>;
  list(actor: TaskActorRef, q: TaskListQuery): Promise<TaskDto[]>;
  accept(actor: TaskActorRef, taskId: string): Promise<TaskDto>;
  complete(actor: TaskActorRef, taskId: string, reason?: string | null): Promise<TaskDto>;
  cancel(actor: TaskActorRef, taskId: string, reason?: string | null): Promise<TaskDto>;
  reassign(actor: TaskActorRef, taskId: string, assigneeUserId: string): Promise<TaskDto>;
  openTaskCount(orgId: string, patientId: string, userId: string): Promise<number>;
}

export interface TaskServiceDeps {
  readonly db: DbClient;
  readonly outbox: HintOutboxPort | undefined;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
  };
  readonly messageLookup: (
    orgId: string,
    channelId: string,
    messageId: string,
  ) => Promise<MessageFacts | null>;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  readonly now?: () => Date;
  /** Injected in tests; the database store otherwise. */
  readonly store?: TaskStore;
}

/** One refusal for missing / not a participant / channel no longer visible / message gone: names nothing. */
const notFound = (): NotFoundError => new NotFoundError("communication_task");
const assigneeInvalid = (): WardenXError =>
  new WardenXError("TASK_ASSIGNEE_INVALID", "assignee cannot be assigned this task", 422);
const stateConflict = (): WardenXError =>
  new WardenXError("TASK_STATE_CONFLICT", "task is not in a state that allows this", 409);
const assigneeHasActive = (): WardenXError =>
  new WardenXError(
    "TASK_ASSIGNEE_ALREADY_HAS_ACTIVE",
    "assignee already has an active task on this message",
    409,
  );

/** Store errors become the typed envelope errors; anything else propagates untouched. */
function mapStoreError(err: unknown): never {
  if (err instanceof TaskNotFound) throw notFound();
  if (err instanceof TaskStateConflict) throw stateConflict();
  if (err instanceof TaskAssigneeAlreadyHasActive) throw assigneeHasActive();
  throw err;
}

function parseReason(reason: string | null | undefined): TaskCloseReason | null {
  if (reason === undefined || reason === null) return null;
  if (!(TASK_CLOSE_REASONS as readonly string[]).includes(reason)) {
    throw new WardenXError("TASK_CLOSE_REASON_INVALID", "closing reason is not recognised", 422);
  }
  return reason as TaskCloseReason;
}

/** The wire shape of a task row for one viewer. Shared with the medication-question service (WP 3.10). */
export function taskRowToDto(
  row: TaskRow,
  userId: string,
  nameOf: ReadonlyMap<string, string | null>,
  now: Date,
): TaskDto {
  const status = row.status as TaskStatus;
  return {
    id: row.id,
    message_id: row.messageId,
    channel_id: row.channelId,
    patient_id: row.patientId,
    created_by: row.createdBy,
    assignee_id: row.assigneeId,
    assignee_display_name: nameOf.get(row.assigneeId) ?? null,
    created_by_display_name: nameOf.get(row.createdBy) ?? null,
    due_at: row.dueAt ? row.dueAt.toISOString() : null,
    status,
    clinical_concern: row.clinicalConcern,
    closed_reason: row.closedReason as TaskCloseReason | null,
    needs_owner: row.needsOwner,
    source_kind: row.sourceKind as TaskSourceKind,
    overdue: isOverdue({ status, dueAt: row.dueAt }, now),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    allowed_actions: allowedActions({ status }, taskActorRole(row, userId)),
  };
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const store = deps.store ?? createDbTaskStore(deps.db);
  const clock = deps.now ?? (() => new Date());

  const canView = (orgId: string, userId: string, channelId: string) =>
    deps.messaging.canViewChannel(orgId, userId, channelId);

  async function names(orgId: string, ids: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const id of new Set(ids)) out.set(id, await deps.displayName(orgId, id));
    return out;
  }

  const toDto = (row: TaskRow, userId: string, nameOf: Map<string, string | null>): TaskDto =>
    taskRowToDto(row, userId, nameOf, clock());

  const toEventDto = (e: TaskEventRow): TaskEventDto => ({
    id: e.id,
    task_id: e.taskId,
    event_type: e.eventType as TaskEventType,
    actor_kind: e.actorKind as TaskEventDto["actor_kind"],
    actor_user_id: e.actorUserId,
    from_status: e.fromStatus as TaskStatus | null,
    to_status: e.toStatus as TaskStatus | null,
    from_assignee_id: e.fromAssigneeId,
    to_assignee_id: e.toAssigneeId,
    reason_code: e.reasonCode,
    created_at: e.createdAt.toISOString(),
  });

  async function dtoFor(row: TaskRow, userId: string): Promise<TaskDto> {
    return toDto(row, userId, await names(row.organizationId, [row.assigneeId, row.createdBy]));
  }

  /** The task for a participant whose channel access still holds; the uniform not-found otherwise. */
  async function visibleTask(actor: TaskActorRef, taskId: string): Promise<TaskRow> {
    const row = await store.getForParticipant(actor.orgId, actor.userId, taskId);
    if (!row || !(await canView(actor.orgId, actor.userId, row.channelId))) throw notFound();
    return row;
  }

  async function act(
    actor: TaskActorRef,
    taskId: string,
    action: TaskAction,
    extra: { reason?: string | null; toAssigneeId?: string } = {},
  ): Promise<TaskDto> {
    const reason = action === "complete" || action === "cancel" ? parseReason(extra.reason) : null;
    const row = await visibleTask(actor, taskId);
    const decision = decideTransition(
      { status: row.status as TaskStatus },
      action,
      taskActorRole(row, actor.userId),
    );
    if (decision.kind === "forbidden") throw new ForbiddenError("not permitted");
    if (decision.kind === "conflict") throw stateConflict();
    if (decision.kind === "noop") return dtoFor(row, actor.userId);
    if (
      (action === "complete" || action === "cancel") &&
      reason === null &&
      requiresCloseReason(row)
    ) {
      throw new WardenXError(
        "TASK_CLOSE_REASON_REQUIRED",
        "a closing reason is required for this task",
        422,
      );
    }
    if (action === "reassign") {
      const target = extra.toAssigneeId ?? "";
      if (!target || !(await canView(actor.orgId, target, row.channelId))) throw assigneeInvalid();
      // WP 3.10: a medication question never goes back to the person who asked it.
      if (row.sourceKind === "medication_question" && target === row.createdBy) {
        throw assigneeInvalid();
      }
    }
    return commit(actor, row, action, reason, extra.toAssigneeId);
  }

  async function commit(
    actor: TaskActorRef,
    row: TaskRow,
    action: TaskAction,
    reason: TaskCloseReason | null,
    toAssigneeId: string | undefined,
  ): Promise<TaskDto> {
    try {
      const result = await withOrgContext(
        deps.db,
        { organizationId: actor.orgId, userId: actor.userId },
        async (tx) => {
          const r = await store.transition(tx, {
            orgId: actor.orgId,
            taskId: row.id,
            actor: { kind: "user", userId: actor.userId },
            action,
            reason,
            ...(toAssigneeId ? { toAssigneeId } : {}),
          });
          if (r.changed) {
            const at = clock();
            if (action === "reassign") {
              await publishTaskEvent(deps.outbox, tx, {
                kind: "reassigned",
                orgId: actor.orgId,
                taskId: row.id,
                channelId: row.channelId,
                fromUserId: row.assigneeId,
                toUserId: r.task.assigneeId,
                source: "manual",
                at,
              });
            } else {
              await publishTaskEvent(deps.outbox, tx, {
                kind: "statusChanged",
                orgId: actor.orgId,
                taskId: row.id,
                channelId: row.channelId,
                from: row.status as TaskStatus,
                to: r.task.status as TaskStatus,
                at,
              });
            }
          }
          return r;
        },
      );
      return await dtoFor(result.task, actor.userId);
    } catch (err) {
      return mapStoreError(err);
    }
  }

  return {
    async convert(actor, a) {
      const dueAt = a.dueAt ?? null;
      if (validateDue(dueAt, clock()) !== null) {
        throw new WardenXError("TASK_DUE_INVALID", "due date is outside the allowed window", 422);
      }
      if (!(await canView(actor.orgId, actor.userId, a.channelId))) throw notFound();
      const msg = await deps.messageLookup(actor.orgId, a.channelId, a.messageId);
      if (!msg || !msg.live) throw notFound();
      if (msg.archived === true) {
        throw new WardenXError("CHANNEL_ARCHIVED", "channel is archived", 410);
      }
      if (!(await canView(actor.orgId, a.assigneeUserId, a.channelId))) throw assigneeInvalid();
      const patientId = derivePatient(msg.channelKind, msg.subjectId);
      const clinicalConcern = patientId !== null || a.clinicalConcern === true;
      try {
        const result = await withOrgContext(
          deps.db,
          { organizationId: actor.orgId, userId: actor.userId },
          async (tx) => {
            const r = await store.createOrGetActive(tx, {
              orgId: actor.orgId,
              messageId: a.messageId,
              channelId: a.channelId,
              patientId,
              createdBy: actor.userId,
              assigneeId: a.assigneeUserId,
              dueAt,
              clinicalConcern,
            });
            if (r.created) {
              await publishTaskEvent(deps.outbox, tx, {
                kind: "created",
                orgId: actor.orgId,
                taskId: r.task.id,
                messageId: a.messageId,
                channelId: a.channelId,
                assigneeUserId: a.assigneeUserId,
                createdByUserId: actor.userId,
                at: clock(),
              });
            }
            return r;
          },
        );
        // A replay returns the existing row, which may be someone else's task: only its creator or assignee may read it.
        const participant =
          result.task.createdBy === actor.userId || result.task.assigneeId === actor.userId;
        if (!result.created && !participant) throw assigneeHasActive();
        return { task: await dtoFor(result.task, actor.userId), created: result.created };
      } catch (err) {
        return mapStoreError(err);
      }
    },

    async get(actor, taskId) {
      const row = await visibleTask(actor, taskId);
      const events = await store.events(actor.orgId, row.id);
      return { task: await dtoFor(row, actor.userId), events: events.map(toEventDto) };
    },

    async list(actor, q) {
      const rows = await store.list(actor.orgId, actor.userId, q);
      const visible = new Map<string, boolean>();
      const kept: TaskRow[] = [];
      for (const row of rows) {
        if (!visible.has(row.channelId)) {
          visible.set(row.channelId, await canView(actor.orgId, actor.userId, row.channelId));
        }
        if (visible.get(row.channelId)) kept.push(row);
      }
      const nameOf = await names(
        actor.orgId,
        kept.flatMap((r) => [r.assigneeId, r.createdBy]),
      );
      return kept.map((r) => toDto(r, actor.userId, nameOf));
    },

    accept: (actor, taskId) => act(actor, taskId, "accept"),
    complete: (actor, taskId, reason) => act(actor, taskId, "complete", { reason }),
    cancel: (actor, taskId, reason) => act(actor, taskId, "cancel", { reason }),
    reassign: (actor, taskId, assigneeUserId) =>
      act(actor, taskId, "reassign", { toAssigneeId: assigneeUserId }),

    async openTaskCount(orgId, patientId, userId) {
      const rows = await store.countActiveForPatient(orgId, patientId, userId);
      const visible = new Map<string, boolean>();
      let count = 0;
      for (const { channelId } of rows) {
        if (!visible.has(channelId))
          visible.set(channelId, await canView(orgId, userId, channelId));
        if (visible.get(channelId)) count += 1;
      }
      return count;
    },
  };
}
