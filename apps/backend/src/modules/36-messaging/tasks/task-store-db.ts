// apps/backend/src/modules/36-messaging/tasks/task-store-db.ts - WP 3.4: the `communication_task` rows and their
// append-only `communication_task_event` history.
//
// Writes take the caller's `tx` (the service owns the transaction and publishes the outbox event inside it). Every
// statement names the organization on top of RLS. `wardenx_app` may UPDATE only the status columns and has no DELETE.
// The partial unique index is the idempotency arbiter for create; transitions lock the row first, so two racing
// transitions serialise and the loser sees the winner's state (replay or conflict), never a lost update.
import { type DbClient, schema } from "@wardenx/db";
import { type TaskActorRole, decideTransition, taskActorRole } from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import {
  TASK_ACTIVE_STATUSES,
  TASK_CLOSED_STATUSES,
  type TaskAction,
  type TaskEventType,
  type TaskStatus,
} from "@wardenx/types";
import { and, asc, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Tx } from "../messaging-write-core";

const T = schema.communicationTasks;
const E = schema.communicationTaskEvents;

export type TaskRow = typeof T.$inferSelect;
export type TaskEventRow = typeof E.$inferSelect;

export type TaskActor =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "system" };

export const TASK_LIST_DEFAULT_LIMIT = 50;
export const TASK_LIST_MAX_LIMIT = 100;

/** The row is not in a state this action may start from (a closed task, or a repeat by the wrong actor). */
export class TaskStateConflict extends Error {
  constructor() {
    super("task state conflict");
    this.name = "TaskStateConflict";
  }
}

/** The task does not exist for this actor (missing, or the actor is not a participant): the uniform not-found. */
export class TaskNotFound extends Error {
  constructor() {
    super("task not found");
    this.name = "TaskNotFound";
  }
}

/** The target assignee already holds an active task on the message. */
export class TaskAssigneeAlreadyHasActive extends Error {
  constructor() {
    super("assignee already has an active task on this message");
    this.name = "TaskAssigneeAlreadyHasActive";
  }
}

export interface CreateTaskArgs {
  readonly orgId: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly patientId: string | null;
  readonly createdBy: string;
  readonly assigneeId: string;
  readonly dueAt: Date | null;
  readonly clinicalConcern: boolean;
}

export interface TransitionArgs {
  readonly orgId: string;
  readonly taskId: string;
  readonly actor: TaskActor;
  readonly action: TaskAction;
  readonly reason?: string | null;
  readonly toAssigneeId?: string;
}

export interface TaskListQuery {
  readonly scope: "assigned" | "created";
  readonly state: "active" | "closed" | "all";
  readonly limit: number;
}

export interface TaskStore {
  createOrGetActive(tx: Tx, a: CreateTaskArgs): Promise<{ task: TaskRow; created: boolean }>;
  /** The task if the user is its creator or assignee, else null. */
  getForParticipant(orgId: string, userId: string, taskId: string): Promise<TaskRow | null>;
  list(orgId: string, userId: string, q: TaskListQuery): Promise<TaskRow[]>;
  events(orgId: string, taskId: string): Promise<TaskEventRow[]>;
  /** Channels of the user's own active tasks on the patient; the caller filters by channel visibility. */
  countActiveForPatient(
    orgId: string,
    patientId: string,
    userId: string,
  ): Promise<{ channelId: string }[]>;
  /** Throws TaskNotFound, TaskStateConflict or TaskAssigneeAlreadyHasActive. `changed:false` = idempotent replay. */
  transition(tx: Tx, a: TransitionArgs): Promise<{ task: TaskRow; changed: boolean }>;

  // Offboarding (task-reassign.ts)
  /** Ids of active, not-yet-flagged tasks assigned to the leaver, oldest first. */
  leaverTaskIds(
    orgId: string,
    leaverUserId: string,
    limit: number,
    excludeIds: readonly string[],
  ): Promise<string[]>;
  /** Locks and returns the task (any state). */
  getForUpdate(tx: Tx, orgId: string, taskId: string): Promise<TaskRow | null>;
  /** Assignees holding an ACTIVE task on the message. */
  activeAssigneeIds(tx: Tx, orgId: string, messageId: string): Promise<string[]>;
  /** Marks an active task ownerless: no event when it is already flagged. */
  flagNeedsOwner(
    tx: Tx,
    a: { orgId: string; taskId: string },
  ): Promise<{ task: TaskRow; changed: boolean }>;
}

const ACTIVE = [...TASK_ACTIVE_STATUSES];
const CLOSED = [...TASK_CLOSED_STATUSES];

const EVENT_FOR_ACTION: Record<TaskAction, TaskEventType> = {
  accept: "accepted",
  complete: "done",
  cancel: "cancelled",
  reassign: "reassigned",
};

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const cause = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505" || cause === "23505";
}

async function insertEvent(
  tx: Tx,
  e: {
    orgId: string;
    taskId: string;
    type: TaskEventType;
    actor: TaskActor;
    fromStatus?: TaskStatus | null;
    toStatus?: TaskStatus | null;
    fromAssigneeId?: string | null;
    toAssigneeId?: string | null;
    reasonCode?: string | null;
  },
): Promise<void> {
  await tx.insert(E).values({
    organizationId: e.orgId,
    taskId: e.taskId,
    eventType: e.type,
    actorUserId: e.actor.kind === "user" ? e.actor.userId : null,
    actorKind: e.actor.kind,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    fromAssigneeId: e.fromAssigneeId ?? null,
    toAssigneeId: e.toAssigneeId ?? null,
    reasonCode: e.reasonCode ?? null,
  });
}

async function selectForUpdate(tx: Tx, orgId: string, taskId: string): Promise<TaskRow | null> {
  const [row] = await tx
    .select()
    .from(T)
    .where(and(eq(T.organizationId, orgId), eq(T.id, taskId)))
    .limit(1)
    .for("update");
  return row ?? null;
}

/** The actor's role on a row. The system actor (offboarding) may do what any participant may. */
function roleOf(task: TaskRow, actor: TaskActor): TaskActorRole {
  return actor.kind === "system" ? "both" : taskActorRole(task, actor.userId);
}

async function applyTransition(
  tx: Tx,
  a: TransitionArgs,
  cur: TaskRow,
  to: TaskStatus,
): Promise<TaskRow> {
  const closing = a.action === "complete" || a.action === "cancel";
  const reassign = a.action === "reassign";
  if (reassign) {
    if (!a.toAssigneeId) throw new TaskStateConflict();
    const holders = await activeAssignees(tx, a.orgId, cur.messageId);
    if (holders.includes(a.toAssigneeId)) throw new TaskAssigneeAlreadyHasActive();
  }
  const now = new Date();
  const [updated] = await tx
    .update(T)
    .set({
      status: to,
      updatedAt: now,
      version: sql`${T.version} + 1`,
      ...(closing ? { closedAt: now, closedReason: a.reason ?? null } : {}),
      ...(a.action === "accept" ? { acceptedAt: now } : {}),
      ...(reassign
        ? { assigneeId: a.toAssigneeId as string, acceptedAt: null, needsOwner: false }
        : {}),
    })
    .where(and(eq(T.organizationId, a.orgId), eq(T.id, a.taskId), inArray(T.status, ACTIVE)))
    .returning();
  if (!updated) throw new TaskStateConflict();
  await insertEvent(tx, {
    orgId: a.orgId,
    taskId: a.taskId,
    type: EVENT_FOR_ACTION[a.action],
    actor: a.actor,
    fromStatus: cur.status as TaskStatus,
    toStatus: to,
    ...(reassign
      ? {
          fromAssigneeId: cur.assigneeId,
          toAssigneeId: a.toAssigneeId ?? null,
          reasonCode: a.actor.kind === "system" ? "offboarding" : "manual",
        }
      : { reasonCode: closing ? (a.reason ?? null) : null }),
  });
  return updated;
}

async function activeAssignees(tx: Tx, orgId: string, messageId: string): Promise<string[]> {
  const rows = await tx
    .select({ assigneeId: T.assigneeId })
    .from(T)
    .where(and(eq(T.organizationId, orgId), eq(T.messageId, messageId), inArray(T.status, ACTIVE)));
  return rows.map((r) => r.assigneeId);
}

export function createDbTaskStore(db: DbClient): TaskStore {
  return {
    async createOrGetActive(tx, a) {
      const [inserted] = await tx
        .insert(T)
        .values({
          organizationId: a.orgId,
          messageId: a.messageId,
          channelId: a.channelId,
          patientId: a.patientId,
          createdBy: a.createdBy,
          assigneeId: a.assigneeId,
          dueAt: a.dueAt,
          clinicalConcern: a.clinicalConcern,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        await insertEvent(tx, {
          orgId: a.orgId,
          taskId: inserted.id,
          type: "created",
          actor: { kind: "user", userId: a.createdBy },
          toStatus: "open",
          toAssigneeId: a.assigneeId,
        });
        return { task: inserted, created: true };
      }
      const [existing] = await tx
        .select()
        .from(T)
        .where(
          and(
            eq(T.organizationId, a.orgId),
            eq(T.messageId, a.messageId),
            eq(T.assigneeId, a.assigneeId),
            inArray(T.status, ACTIVE),
          ),
        )
        .limit(1);
      if (!existing) throw new TaskStateConflict();
      return { task: existing, created: false };
    },

    getForParticipant: (orgId, userId, taskId) =>
      withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const [row] = await tx
          .select()
          .from(T)
          .where(
            and(
              eq(T.organizationId, orgId),
              eq(T.id, taskId),
              or(eq(T.createdBy, userId), eq(T.assigneeId, userId)),
            ),
          )
          .limit(1);
        return row ?? null;
      }),

    list: (orgId, userId, q) =>
      withOrgContext(db, { organizationId: orgId, userId }, (tx) => {
        const limit = Math.min(
          Math.max(Math.trunc(q.limit) || TASK_LIST_DEFAULT_LIMIT, 1),
          TASK_LIST_MAX_LIMIT,
        );
        const mine = q.scope === "assigned" ? eq(T.assigneeId, userId) : eq(T.createdBy, userId);
        const stateFilter =
          q.state === "active"
            ? inArray(T.status, ACTIVE)
            : q.state === "closed"
              ? inArray(T.status, CLOSED)
              : undefined;
        // Overdue first, then soonest due (undated last), then newest. now() is the transaction's instant.
        const overdue = sql`(${T.status} IN ('open', 'accepted') AND ${T.dueAt} IS NOT NULL AND ${T.dueAt} < now())`;
        return tx
          .select()
          .from(T)
          .where(and(eq(T.organizationId, orgId), mine, stateFilter))
          .orderBy(desc(overdue), sql`${T.dueAt} ASC NULLS LAST`, desc(T.createdAt), asc(T.id))
          .limit(limit);
      }),

    events: (orgId, taskId) =>
      withOrgContext(db, systemOrgContext(orgId), (tx) =>
        tx
          .select()
          .from(E)
          .where(and(eq(E.organizationId, orgId), eq(E.taskId, taskId)))
          .orderBy(asc(E.createdAt), asc(E.id)),
      ),

    countActiveForPatient: (orgId, patientId, userId) =>
      withOrgContext(db, { organizationId: orgId, userId }, (tx) =>
        tx
          .select({ channelId: T.channelId })
          .from(T)
          .where(
            and(
              eq(T.organizationId, orgId),
              eq(T.patientId, patientId),
              inArray(T.status, ACTIVE),
              or(eq(T.assigneeId, userId), eq(T.createdBy, userId)),
            ),
          ),
      ),

    async transition(tx, a) {
      const cur = await selectForUpdate(tx, a.orgId, a.taskId);
      if (!cur) throw new TaskNotFound();
      const decision = decideTransition(
        { status: cur.status as TaskStatus },
        a.action,
        roleOf(cur, a.actor),
      );
      if (decision.kind === "forbidden") throw new TaskNotFound();
      if (decision.kind === "noop") return { task: cur, changed: false };
      if (decision.kind === "conflict") throw new TaskStateConflict();
      try {
        return { task: await applyTransition(tx, a, cur, decision.to), changed: true };
      } catch (err) {
        // A racing create of the same (message, assignee) lost to the unique index after our pre-check.
        if (isUniqueViolation(err)) throw new TaskAssigneeAlreadyHasActive();
        throw err;
      }
    },

    leaverTaskIds: (orgId, leaverUserId, limit, excludeIds) =>
      withOrgContext(db, systemOrgContext(orgId), async (tx) => {
        const rows = await tx
          .select({ id: T.id })
          .from(T)
          .where(
            and(
              eq(T.organizationId, orgId),
              eq(T.assigneeId, leaverUserId),
              inArray(T.status, ACTIVE),
              eq(T.needsOwner, false),
              excludeIds.length > 0 ? notInArray(T.id, [...excludeIds]) : undefined,
            ),
          )
          .orderBy(asc(T.createdAt), asc(T.id))
          .limit(limit);
        return rows.map((r) => r.id);
      }),

    getForUpdate: (tx, orgId, taskId) => selectForUpdate(tx, orgId, taskId),

    activeAssigneeIds: (tx, orgId, messageId) => activeAssignees(tx, orgId, messageId),

    async flagNeedsOwner(tx, a) {
      const cur = await selectForUpdate(tx, a.orgId, a.taskId);
      if (!cur) throw new TaskNotFound();
      if (!ACTIVE.includes(cur.status as (typeof ACTIVE)[number])) throw new TaskStateConflict();
      if (cur.needsOwner) return { task: cur, changed: false };
      const [updated] = await tx
        .update(T)
        .set({ needsOwner: true, updatedAt: new Date(), version: sql`${T.version} + 1` })
        .where(and(eq(T.organizationId, a.orgId), eq(T.id, a.taskId)))
        .returning();
      if (!updated) throw new TaskStateConflict();
      await insertEvent(tx, {
        orgId: a.orgId,
        taskId: a.taskId,
        type: "needs_owner",
        actor: { kind: "system" },
        fromStatus: cur.status as TaskStatus,
        toStatus: cur.status as TaskStatus,
        fromAssigneeId: cur.assigneeId,
      });
      return { task: updated, changed: true };
    },
  };
}
