// WP 3.4: turns task outbox events into one generic in-app alert (AlertEmitter seam), like message-mentions.ts.
// The tenant comes from the envelope, never the payload. The recipient's channel access is re-checked now (a stale
// event must not alert someone who lost access). The text is fixed and PROVISIONAL (clinical-lead sign-off pending):
// no names, no patient, no message text. Tasks do not page anyone; this is an inbox entry, not the emergency path.
import type { AlertEmitter, MessagingRouteService } from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { M36_TASK_EVENTS } from "../tasks/task-events";

export const M36_TASK_NOTIFICATION_CONSUMER = "m36.task-notifications" as const;
export const M36_TASK_NOTIFICATION_EVENTS = [
  M36_TASK_EVENTS.created,
  M36_TASK_EVENTS.reassigned,
  M36_TASK_EVENTS.needsOwner,
] as const;

export const TASK_NOTIFICATION_TEXT = {
  assigned: "A colleague assigned you a task",
  needsOwner: "A task you created needs a new owner",
} as const;

const TASKS_DEEP_LINK = "/notifications?tab=tasks";

function requireId(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_TASK_NOTIFICATION_CONSUMER}: missing ${key}`);
  }
  return value;
}

interface Notification {
  readonly recipientKey: "assigneeUserId" | "toUserId" | "creatorUserId";
  readonly recipient: string;
  readonly message: string;
  readonly extra: Record<string, string>;
  /** The user whose own action this is; never alerted about it. */
  readonly actor: string | null;
}

function notificationFor(eventType: string, payload: Record<string, unknown>): Notification | null {
  switch (eventType) {
    case M36_TASK_EVENTS.created:
      return {
        recipientKey: "assigneeUserId",
        recipient: requireId(payload, "assigneeUserId"),
        message: TASK_NOTIFICATION_TEXT.assigned,
        extra: { messageId: requireId(payload, "messageId") },
        actor: requireId(payload, "createdByUserId"),
      };
    case M36_TASK_EVENTS.reassigned:
      return {
        recipientKey: "toUserId",
        recipient: requireId(payload, "toUserId"),
        message: TASK_NOTIFICATION_TEXT.assigned,
        extra: {},
        actor: null,
      };
    case M36_TASK_EVENTS.needsOwner:
      return {
        recipientKey: "creatorUserId",
        recipient: requireId(payload, "creatorUserId"),
        message: TASK_NOTIFICATION_TEXT.needsOwner,
        extra: {},
        actor: null,
      };
    default:
      return null;
  }
}

export function buildM36TaskNotificationsConsumer(deps: {
  readonly alerts: AlertEmitter;
  readonly messaging: Pick<MessagingRouteService, "canViewChannel">;
}): OutboxConsumerBinding {
  return {
    consumerName: M36_TASK_NOTIFICATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_TASK_NOTIFICATION_EVENTS,
    async handle(event: DispatchableOutboxEvent) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const taskId = requireId(payload, "taskId");
      const channelId = requireId(payload, "channelId");
      const note = notificationFor(event.eventType, payload);
      if (!note || note.actor === note.recipient) return;

      if (!(await deps.messaging.canViewChannel(event.organizationId, note.recipient, channelId))) {
        return;
      }
      await deps.alerts.emit(event.organizationId, {
        eventType: event.eventType,
        severity: "info",
        correlationId: `task:${taskId}:${event.id}:${note.recipient}`,
        payload: {
          [note.recipientKey]: note.recipient,
          channelId,
          ...note.extra,
          message: note.message,
          deepLink: TASKS_DEEP_LINK,
        },
      });
    },
  };
}
