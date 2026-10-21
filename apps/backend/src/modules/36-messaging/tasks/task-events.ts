// apps/backend/src/modules/36-messaging/tasks/task-events.ts - WP 3.4: the transactional outbox events a task write emits.
// PHI-free by construction: ids, enums and instants only - never a patient id, a reason or any text. Published in the
// SAME transaction as the write (the caller passes its `tx`), so an event never announces a write that rolled back.
// An idempotent replay changes nothing and therefore publishes nothing. The catalog entries live in events-by-m36.ts.
import type { TaskReassignSource, TaskStatus } from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";

export const M36_TASK_EVENTS = {
  created: "m36.task.created",
  reassigned: "m36.task.reassigned",
  needsOwner: "m36.task.needs_owner",
  statusChanged: "m36.task.status_changed",
} as const;

export const TASK_AGGREGATE_KIND = "communication_task";

export type TaskEventFacts =
  | {
      readonly kind: "created";
      readonly orgId: string;
      readonly taskId: string;
      readonly messageId: string;
      readonly channelId: string;
      readonly assigneeUserId: string;
      readonly createdByUserId: string;
      readonly at: Date;
    }
  | {
      readonly kind: "reassigned";
      readonly orgId: string;
      readonly taskId: string;
      readonly channelId: string;
      readonly fromUserId: string;
      readonly toUserId: string;
      readonly source: TaskReassignSource;
      readonly at: Date;
    }
  | {
      readonly kind: "needsOwner";
      readonly orgId: string;
      readonly taskId: string;
      readonly channelId: string;
      readonly creatorUserId: string;
      readonly at: Date;
    }
  | {
      readonly kind: "statusChanged";
      readonly orgId: string;
      readonly taskId: string;
      readonly channelId: string;
      readonly from: TaskStatus;
      readonly to: TaskStatus;
      readonly at: Date;
    };

/** The event payload: everything but `kind`, `at` as an ISO instant, `organizationId` named as the catalog expects. */
export function taskEventPayload(facts: TaskEventFacts): Record<string, unknown> {
  const { kind: _kind, orgId, at, ...rest } = facts;
  return { organizationId: orgId, ...rest, at: at.toISOString() };
}

export async function publishTaskEvent(
  outbox: HintOutboxPort | undefined,
  tx: unknown,
  facts: TaskEventFacts,
): Promise<void> {
  await outbox?.publish(tx, {
    eventName: M36_TASK_EVENTS[facts.kind],
    organizationId: facts.orgId,
    aggregateKind: TASK_AGGREGATE_KIND,
    aggregateId: facts.taskId,
    payload: taskEventPayload(facts),
  });
}
