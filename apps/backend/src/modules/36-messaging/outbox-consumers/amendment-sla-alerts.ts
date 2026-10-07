// apps/backend/src/modules/36-messaging/outbox-consumers/amendment-sla-alerts.ts — GAP-118.
// M36's consumer of M5's amendment-SLA events (HIPAA 45 CFR 164.526(b)(2): act within 60 days):
//
//   m5.patient.amendment_sla_due_soon -> alert `m5.patient.amendment_sla_due_soon`   (privacy officer + compliance)
//   m5.patient.amendment_sla_overdue  -> alert `m5.patient.amendment_sla_overdue`    (privacy officer + compliance)
//
// RECIPIENTS come from the platform `alert_rule` rows (packages/messaging seed). M36 never imports M5 — events
// are matched by name. IDEMPOTENCY: one deterministic correlation id per (amendment, tier), and `alert` is UNIQUE
// on (organization_id, correlation_id), so a redelivery never pages twice. NO PHI: ids and the due instant only.
// A malformed event THROWS (retry -> DLQ, never a silently dropped alert).
import type { AlertEmitter } from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_AMENDMENT_SLA_ALERT_CONSUMER = "m36.amendment-sla-alerts" as const;

export const M36_AMENDMENT_SLA_ALERT_EVENT_TYPES = [
  "m5.patient.amendment_sla_due_soon",
  "m5.patient.amendment_sla_overdue",
] as const;

export interface AmendmentSlaAlertPlan {
  readonly alertEventType: string;
  readonly correlationKey: string;
  readonly safe: Record<string, unknown>;
}

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0)
    throw new Error(`${M36_AMENDMENT_SLA_ALERT_CONSUMER}: ${eventName} payload has no ${key}`);
  return v;
}

/** Pure: the alert one delivered event raises. */
export function planAmendmentSlaAlert(
  event: Pick<DispatchableOutboxEvent, "eventType" | "payload">,
): AmendmentSlaAlertPlan {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const name = event.eventType;
  if (!(M36_AMENDMENT_SLA_ALERT_EVENT_TYPES as readonly string[]).includes(name))
    throw new Error(`${M36_AMENDMENT_SLA_ALERT_CONSUMER}: unexpected event ${name}`);
  const amendmentId = requireString(p, "amendmentId", name);
  const patientId = requireString(p, "patientId", name);
  const overdue = name === "m5.patient.amendment_sla_overdue";
  return {
    alertEventType: name,
    correlationKey: `${amendmentId}:${overdue ? "overdue" : "due_soon"}`,
    safe: {
      patientId,
      amendmentId,
      slaDueAt: requireString(p, "slaDueAt", name),
      deepLink: `/patients/${patientId}/privacy`,
      message: overdue
        ? "An amendment request passed its 60-day deadline without a decision (45 CFR 164.526(b)(2))."
        : "An amendment request is within 10 days of its 60-day deadline (45 CFR 164.526(b)(2)).",
    },
  };
}

export function buildM36AmendmentSlaAlertConsumer(alerts: AlertEmitter): OutboxConsumerBinding {
  return {
    consumerName: M36_AMENDMENT_SLA_ALERT_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_AMENDMENT_SLA_ALERT_EVENT_TYPES,
    async handle(event) {
      const plan = planAmendmentSlaAlert(event);
      await alerts.emit(event.organizationId, {
        eventType: plan.alertEventType,
        severity: "warn",
        correlationId: `outbox:${event.eventType}:${plan.correlationKey}`,
        payload: { eventType: event.eventType, ...plan.safe },
      });
    },
  };
}
