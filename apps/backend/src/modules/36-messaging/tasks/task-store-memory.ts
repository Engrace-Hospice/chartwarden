// apps/backend/src/modules/36-messaging/tasks/task-store-memory.ts - WP 3.4: an in-memory TaskStore that applies the same
// rules as the database store (one active task per message and assignee, the shared transition table). It exists for
// unit tests of the service and the offboarding job; the database behaviour itself is proven by the live suite.
import { decideTransition, taskActorRole } from "@wardenx/messaging";
import type { TaskAction, TaskEventType, TaskStatus } from "@wardenx/types";
import {
  type TaskActor,
  TaskAssigneeAlreadyHasActive,
  type TaskEventRow,
  TaskNotFound,
  type TaskRow,
  TaskStateConflict,
  type TaskStore,
  reassignReasonOf,
} from "./task-store-db";

const isActive = (status: string): boolean => status === "open" || status === "accepted";

export interface MemoryTaskStore extends TaskStore {
  readonly tasks: Map<string, TaskRow>;
  readonly eventLog: TaskEventRow[];
}

export function createMemoryTaskStore(): MemoryTaskStore {
  const tasks = new Map<string, TaskRow>();
  const eventLog: TaskEventRow[] = [];
  let seq = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  const log = (
    orgId: string,
    taskId: string,
    type: TaskEventType,
    actor: TaskActor,
    extra: Partial<TaskEventRow> = {},
  ) =>
    eventLog.push({
      id: nextId(),
      organizationId: orgId,
      taskId,
      eventType: type,
      actorUserId: actor.kind === "user" ? actor.userId : null,
      actorKind: actor.kind,
      fromStatus: null,
      toStatus: null,
      fromAssigneeId: null,
      toAssigneeId: null,
      reasonCode: null,
      createdAt: new Date(),
      ...extra,
    });

  const holders = (orgId: string, messageId: string) =>
    [...tasks.values()].filter(
      (t) => t.organizationId === orgId && t.messageId === messageId && isActive(t.status),
    );

  const put = (row: TaskRow): TaskRow => {
    tasks.set(row.id, row);
    return row;
  };

  return {
    tasks,
    eventLog,
    async createOrGetActive(_tx, a) {
      const existing = holders(a.orgId, a.messageId).find((t) => t.assigneeId === a.assigneeId);
      if (existing) return { task: existing, created: false };
      const now = new Date();
      const task = put({
        id: nextId(),
        organizationId: a.orgId,
        messageId: a.messageId,
        channelId: a.channelId,
        patientId: a.patientId,
        createdBy: a.createdBy,
        assigneeId: a.assigneeId,
        dueAt: a.dueAt,
        status: "open",
        clinicalConcern: a.clinicalConcern,
        closedReason: null,
        needsOwner: false,
        acceptedAt: null,
        closedAt: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
      });
      log(
        a.orgId,
        task.id,
        "created",
        { kind: "user", userId: a.createdBy },
        {
          toStatus: "open",
          toAssigneeId: a.assigneeId,
        },
      );
      return { task, created: true };
    },
    async getForParticipant(orgId, userId, taskId) {
      const t = tasks.get(taskId);
      const ok =
        t && t.organizationId === orgId && (t.createdBy === userId || t.assigneeId === userId);
      return ok ? t : null;
    },
    async list(orgId, userId, q) {
      return [...tasks.values()]
        .filter((t) => t.organizationId === orgId)
        .filter((t) => (q.scope === "assigned" ? t.assigneeId === userId : t.createdBy === userId))
        .filter((t) => q.state === "all" || isActive(t.status) === (q.state === "active"))
        .slice(0, q.limit);
    },
    async events(orgId, taskId) {
      return eventLog.filter((e) => e.organizationId === orgId && e.taskId === taskId);
    },
    async countActiveForPatient(orgId, patientId, userId) {
      return [...tasks.values()]
        .filter(
          (t) => t.organizationId === orgId && t.patientId === patientId && isActive(t.status),
        )
        .filter((t) => t.assigneeId === userId || t.createdBy === userId)
        .map((t) => ({ channelId: t.channelId }));
    },
    async transition(_tx, a) {
      const cur = tasks.get(a.taskId);
      if (!cur || cur.organizationId !== a.orgId) throw new TaskNotFound();
      const role =
        a.actor.kind === "system" || a.reassignReason === "handoff" || a.reviewOverride === true
          ? "both"
          : taskActorRole(cur, a.actor.userId);
      const d = decideTransition(
        { status: cur.status as TaskStatus },
        a.action as TaskAction,
        role,
      );
      if (d.kind === "forbidden") throw new TaskNotFound();
      if (d.kind === "noop") return { task: cur, changed: false };
      if (d.kind === "conflict") throw new TaskStateConflict();
      const now = new Date();
      if (a.action === "reassign") {
        const target = a.toAssigneeId ?? "";
        if (holders(a.orgId, cur.messageId).some((t) => t.assigneeId === target))
          throw new TaskAssigneeAlreadyHasActive();
      }
      const closing = a.action === "complete" || a.action === "cancel";
      const task = put({
        ...cur,
        status: d.to,
        updatedAt: now,
        version: cur.version + 1,
        ...(closing ? { closedAt: now, closedReason: a.reason ?? null } : {}),
        ...(a.action === "accept" ? { acceptedAt: now } : {}),
        ...(a.action === "reassign"
          ? { assigneeId: a.toAssigneeId ?? cur.assigneeId, acceptedAt: null, needsOwner: false }
          : {}),
      });
      const type: TaskEventType =
        a.action === "accept"
          ? "accepted"
          : a.action === "complete"
            ? "done"
            : a.action === "cancel"
              ? "cancelled"
              : "reassigned";
      log(a.orgId, cur.id, type, a.actor, {
        fromStatus: cur.status,
        toStatus: d.to,
        reasonCode: a.action === "reassign" ? reassignReasonOf(a) : (a.reason ?? null),
        ...(a.action === "reassign"
          ? { fromAssigneeId: cur.assigneeId, toAssigneeId: a.toAssigneeId ?? null }
          : {}),
      });
      return { task, changed: true };
    },
    async leaverTaskIds(orgId, leaver, limit, excludeIds) {
      return [...tasks.values()]
        .filter(
          (t) =>
            t.organizationId === orgId &&
            t.assigneeId === leaver &&
            isActive(t.status) &&
            !t.needsOwner &&
            !excludeIds.includes(t.id),
        )
        .slice(0, limit)
        .map((t) => t.id);
    },
    async activeTaskIdsForAssigneeAndPatient(orgId, userId, patientId) {
      return [...tasks.values()]
        .filter(
          (t) =>
            t.organizationId === orgId &&
            t.assigneeId === userId &&
            t.patientId === patientId &&
            isActive(t.status),
        )
        .map((t) => t.id)
        .sort();
    },
    async getForUpdate(_tx, orgId, taskId) {
      const t = tasks.get(taskId);
      return t && t.organizationId === orgId ? t : null;
    },
    async activeAssigneeIds(_tx, orgId, messageId) {
      return holders(orgId, messageId).map((t) => t.assigneeId);
    },
    async flagNeedsOwner(_tx, a) {
      const cur = tasks.get(a.taskId);
      if (!cur || cur.organizationId !== a.orgId) throw new TaskNotFound();
      if (!isActive(cur.status)) throw new TaskStateConflict();
      if (cur.needsOwner) return { task: cur, changed: false };
      const task = put({
        ...cur,
        needsOwner: true,
        version: cur.version + 1,
        updatedAt: new Date(),
      });
      log(
        a.orgId,
        cur.id,
        "needs_owner",
        { kind: "system" },
        {
          fromStatus: cur.status,
          toStatus: cur.status,
          fromAssigneeId: cur.assigneeId,
        },
      );
      return { task, changed: true };
    },
  };
}
