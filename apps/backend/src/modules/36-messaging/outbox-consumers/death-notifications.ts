// apps/backend/src/modules/36-messaging/outbox-consumers/death-notifications.ts - the death-notification cascade (builds on ADR-0098). Consumes M36's own
// `m36.death_board.opened` (published once, in the board-creating transaction) and fans out the fixed-text, in-app internal notices. Separate from the
// board consumer on purpose: the board stays coordination-only and keeps working with the cascade off. TENANT: from the envelope only. The board id comes
// from the payload and is looked up under that tenant's RLS, so a forged id from another tenant finds nothing and throws (relay retry -> DLQ).
// Gated on the tenant flag `messaging.death_notifications` (checked in the service). Logs carry ids only. External recipients are NEVER sent from here:
// a staff member selects the funeral home explicitly (routes), and the BAA gate decides.
import {
  type DispatchableOutboxEvent,
  type OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { DEATH_NOTIFICATION_EVENTS } from "@chartwarden/types";
import type { DeathNotificationService } from "../death-notification/death-notification-service";

export const M36_DEATH_NOTIFICATIONS_CONSUMER = "m36.death-notifications" as const;
export const M36_DEATH_NOTIFICATIONS_EVENT_TYPES = [DEATH_NOTIFICATION_EVENTS.opened] as const;

export interface DeathNotificationsConsumerDeps {
  readonly service: Pick<DeathNotificationService, "fanOutInternal">;
}

export function buildM36DeathNotificationsConsumer(
  deps: DeathNotificationsConsumerDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M36_DEATH_NOTIFICATIONS_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_DEATH_NOTIFICATIONS_EVENT_TYPES,
    async handle(event: DispatchableOutboxEvent) {
      const boardId = (event.payload as Record<string, unknown> | null)?.boardId;
      if (typeof boardId !== "string" || boardId.length === 0) {
        throw new Error(`${M36_DEATH_NOTIFICATIONS_CONSUMER}: missing boardId`);
      }
      await deps.service.fanOutInternal(event.organizationId, boardId, event.id);
    },
  };
}
