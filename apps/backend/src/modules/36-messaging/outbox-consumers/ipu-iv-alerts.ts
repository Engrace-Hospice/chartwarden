// apps/backend/src/modules/36-messaging/outbox-consumers/ipu-iv-alerts.ts — M36's consumer of M37's IV-continuous
// bedside-check watchdog (M37 §2.6 / D7 / §4.8, GAP-107). M37's `iv-bedside-check-watchdog` cron publishes
// `m37.iv_safety_overlay.bedside_check_overdue` when a running infusion on an IPU patient has gone a full check
// interval without a recorded bedside check; M36 sat on the seam-consumer list and nothing consumed it, so the
// primary IPU nurse was never told.
//
//   event (M37 outbox)                          -> alert eventType (platform `alert_rule`)          severity
//   m37.iv_safety_overlay.bedside_check_overdue -> m37.iv_safety_overlay.bedside_check_overdue       warn
//
// RECIPIENTS: the platform `alert_rule` (packages/messaging seed) resolves the patient's care team via the
// payload's `patientId` (the primary IPU nurse is on it). M36 never imports M37 — events are matched by name.
//
// TENANT: from the envelope `event.organizationId`, NEVER the payload.
//
// IDEMPOTENCY: the correlation id is overlay + the last check instant + the number of missed intervals, so each
// overdue interval is one alert (a recurring reminder, by design) and a relay redelivery or a cron retry of the
// same interval can never page twice (`alert` is UNIQUE on (organization_id, correlation_id)).
//
// NO PHI: ids, instants and counts only (no drug name). A malformed event THROWS (relay retry -> DLQ — a visible
// failure, never a silently dropped safety alert).
import type { AlertEmitter } from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_IPU_IV_ALERT_CONSUMER = "m36.ipu-iv-alerts" as const;
export const M36_IPU_IV_ALERT_EVENT_TYPES = [
  "m37.iv_safety_overlay.bedside_check_overdue",
] as const;

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${M36_IPU_IV_ALERT_CONSUMER}: ${eventName} payload has no ${key}`);
  }
  return v;
}

export function planIpuIvAlert(event: DispatchableOutboxEvent): {
  readonly correlationKey: string;
  readonly safe: Record<string, unknown>;
} {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const name = event.eventType;
  const patientId = requireString(p, "patientId", name);
  const overlayId = requireString(p, "overlayId", name);
  const lastCheckAt = requireString(p, "lastCheckAt", name);
  return {
    correlationKey: `${overlayId}:${lastCheckAt}:${String(p.missedIntervals)}`,
    safe: {
      patientId,
      ipuAdmissionId: p.ipuAdmissionId,
      orderId: p.orderId,
      overlayId,
      lastCheckAt,
      intervalMinutes: p.intervalMinutes,
      minutesOverdue: p.minutesOverdue,
      deepLink: `/patients/${patientId}/emar`,
      message: "A continuous IV infusion's bedside check is overdue.",
    },
  };
}

export function buildM36IpuIvAlertConsumer(alerts: AlertEmitter): OutboxConsumerBinding {
  return {
    consumerName: M36_IPU_IV_ALERT_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_IPU_IV_ALERT_EVENT_TYPES,
    async handle(event) {
      const plan = planIpuIvAlert(event);
      await alerts.emit(event.organizationId, {
        eventType: event.eventType,
        severity: "warn",
        correlationId: `outbox:${event.eventType}:${plan.correlationKey}`,
        payload: { eventType: event.eventType, ...plan.safe },
      });
    },
  };
}
