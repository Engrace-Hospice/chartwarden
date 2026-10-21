// WP 5.7 (ADR-0089, PROPOSED): turns the `m36.export.requested` outbox event into ONE fixed-text in-app alert for the approvers (AlertEmitter
// seam; rule `m36.export.requested`: the holders of messaging.export.approve, the tenant administrators when nobody holds it; system_locked, so
// a tenant may tighten but never disable or re-route it).
//
// The tenant comes from the envelope, never the payload. The alert carries NO name, channel, patient, scope or justification: the job id, the
// requester id and one fixed sentence, with a link to the approvals queue. DURABILITY: a failed emit makes `handle` throw and the relay
// redelivers; the alert is unique on (organization_id, correlation_id) and the correlation id is derived from the job id, so a redelivery after
// a partial success can never alert twice. Only `requested` is consumed: the other export events are trail-only (or the builder's).
import type { AlertEmitter } from "@chartwarden/messaging";
import { EXPORT_REQUESTED_ALERT } from "@chartwarden/types";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { M36_EXPORT_EVENTS } from "../export/export-events";

export const M36_EXPORT_NOTIFICATION_CONSUMER = "m36.export-notifications" as const;
export const M36_EXPORT_NOTIFICATION_EVENTS = [M36_EXPORT_EVENTS.requested] as const;

/** Provisional copy (compliance sign-off pending): says what happened, never who, what or why. */
export const EXPORT_REQUESTED_ALERT_TEXT =
  "A messaging export is waiting for your approval. Review the request before the artefact is built" as const;
/** Where an approver goes: the export approvals queue. */
export const EXPORT_APPROVAL_DEEP_LINK = "/messaging/governance/export-approvals" as const;

function requireText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_EXPORT_NOTIFICATION_CONSUMER}: missing ${key}`);
  }
  return value;
}

export interface ExportNotificationDeps {
  readonly alerts: AlertEmitter;
}

export function buildM36ExportNotificationsConsumer(
  deps: ExportNotificationDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M36_EXPORT_NOTIFICATION_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_EXPORT_NOTIFICATION_EVENTS,
    async handle(event: DispatchableOutboxEvent) {
      if (event.eventType !== M36_EXPORT_EVENTS.requested) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const jobId = requireText(payload, "jobId");
      await deps.alerts.emit(event.organizationId, {
        eventType: EXPORT_REQUESTED_ALERT,
        severity: "warn",
        correlationId: `export:${jobId}:requested`,
        payload: {
          jobId,
          requestedBy: requireText(payload, "requestedBy"),
          message: EXPORT_REQUESTED_ALERT_TEXT,
          deepLink: EXPORT_APPROVAL_DEEP_LINK,
        },
      });
    },
  };
}
