// apps/backend/src/modules/36-messaging/outbox-consumers/field-safety-alerts.ts — M36's consumer of M20's
// check-in watchdog events (GAP-061). M20's overdue detector and coverage-gap watchdog publish these on the
// outbox (M20 spec §4.9/§4.10) but nothing consumed them (M36 sat on the seam-consumer list), so an
// unanswered lone-worker check-in, an escalation rung and an unpaged clinician all raised nothing.
//
//   event (M20 outbox)                    -> alert eventType (platform `alert_rule`)   severity
//   m20.safety.check_in_overdue           -> m20.safety.check_in_overdue                warn
//   m20.safety.check_in_escalated         -> m20.safety.check_in_escalated              critical
//   m20.safety.check_in_escalated         -> m20.safety.check_in_escalated_oncall       critical  (SECOND alert)
//   m20.safety.coverage_gap_detected      -> m20.safety.coverage_gap_detected           critical
//
// ON-CALL PAGE: an alert rule has ONE recipient resolver, and the M19 after-hours on-call roster is not a role
// set. So every escalation rung raises two alerts: the supervisor/DON `role_set` alert above, and a second one
// under the rule key `m20.safety.check_in_escalated_oncall` whose `on_call` resolver pages whoever M19 has on
// shift for the provider entity (read org-explicitly through the OnCallProvider seam). The second key is an
// alert-rule key only — it is NOT an outbox catalog event. Its correlation id carries the same
// `scheduleId:tier` key, so each rung pages the roster once.
//
// RECIPIENTS: each alert type has a platform `alert_rule` (packages/messaging seed) resolving a `role_set`
// (supervisors / scheduling / DON). M36 never imports M20 — events are matched by name.
//
// TENANT: from the envelope `event.organizationId`, NEVER the payload (the payload carries `orgId` only as an
// informational copy; a producer bug there must not re-route a page to another tenant).
//
// IDEMPOTENCY: every alert has a deterministic correlation id and `alert` is UNIQUE on
// (organization_id, correlation_id), so a relay redelivery or a cron retry can never page twice.
//   • check_in_overdue      — keyed on `scheduleId` (M20_EVENT_IDEMPOTENCY_KEYS)
//   • check_in_escalated    — keyed on `scheduleId` + `tier`: ONE event per D4 rung, so a key on the schedule
//                             alone would drop rungs two and three
//   • coverage_gap_detected — keyed on clinician + reason + the detection HOUR: the watchdog is hourly and
//                             re-detects an unresolved gap, so each hour is one reminder, never two
//
// NO PHI: ids, instants and counts only. A malformed event THROWS (relay retry -> DLQ — a visible failure,
// never a silently dropped safety page).
import type { AlertEmitter, AlertSeverity } from "@chartwarden/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

/** Alert-rule key (not an outbox event) of the second, `on_call`-resolved page per escalation rung. */
export const M20_CHECK_IN_ESCALATED_ONCALL_ALERT = "m20.safety.check_in_escalated_oncall" as const;

export const M36_FIELD_SAFETY_ALERT_CONSUMER = "m36.field-safety-alerts" as const;

export const M36_FIELD_SAFETY_ALERT_EVENT_TYPES = [
  "m20.safety.check_in_overdue",
  "m20.safety.check_in_escalated",
  "m20.safety.coverage_gap_detected",
] as const;

/** Characters of an ISO instant that identify its hour (`2026-09-10T15`). */
const ISO_HOUR_LENGTH = 13;

interface FieldSafetyAlertPlan {
  readonly severity: AlertSeverity;
  readonly correlationKey: string;
  readonly safe: Record<string, unknown>;
}

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${M36_FIELD_SAFETY_ALERT_CONSUMER}: ${eventName} payload has no ${key}`);
  }
  return v;
}

function planFor(event: DispatchableOutboxEvent): FieldSafetyAlertPlan {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const name = event.eventType;
  const clinicianMembershipId = requireString(p, "clinicianMembershipId", name);
  const providerEntityId = requireString(p, "providerEntityId", name);
  switch (name) {
    case "m20.safety.check_in_overdue": {
      const scheduleId = requireString(p, "scheduleId", name);
      return {
        severity: "warn",
        correlationKey: scheduleId,
        safe: {
          providerEntityId,
          clinicianMembershipId,
          scheduleId,
          visitId: p.visitId ?? null,
          kind: p.kind,
          expectedAt: p.expectedAt,
          minutesOverdue: p.minutesOverdue,
          deepLink: "/safety",
          message: "A field clinician's safety check-in is overdue.",
        },
      };
    }
    case "m20.safety.check_in_escalated": {
      const scheduleId = requireString(p, "scheduleId", name);
      const tier = requireString(p, "tier", name);
      return {
        severity: "critical",
        correlationKey: `${scheduleId}:${tier}`,
        safe: {
          providerEntityId,
          clinicianMembershipId,
          scheduleId,
          visitId: p.visitId ?? null,
          tier,
          afterHours: p.afterHours === true,
          minutesOverdue: p.minutesOverdue,
          deepLink: "/safety",
          message: "A field clinician's overdue safety check-in has escalated.",
        },
      };
    }
    case "m20.safety.coverage_gap_detected": {
      const reason = requireString(p, "reason", name);
      const detectedAt = requireString(p, "detectedAt", name);
      return {
        severity: "critical",
        correlationKey: `${clinicianMembershipId}:${reason}:${detectedAt.slice(0, ISO_HOUR_LENGTH)}`,
        safe: {
          providerEntityId,
          clinicianMembershipId,
          reason,
          detectedAt,
          deepLink: "/safety",
          message: "A field clinician has nobody subscribed to be paged for her safety alerts.",
        },
      };
    }
    default:
      throw new Error(`${M36_FIELD_SAFETY_ALERT_CONSUMER}: unexpected event ${name}`);
  }
}

export function buildM36FieldSafetyAlertConsumer(alerts: AlertEmitter): OutboxConsumerBinding {
  return {
    consumerName: M36_FIELD_SAFETY_ALERT_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_FIELD_SAFETY_ALERT_EVENT_TYPES,
    async handle(event) {
      const plan = planFor(event);
      await alerts.emit(event.organizationId, {
        eventType: event.eventType,
        severity: plan.severity,
        correlationId: `outbox:${event.eventType}:${plan.correlationKey}`,
        payload: { eventType: event.eventType, ...plan.safe },
      });
      if (event.eventType === "m20.safety.check_in_escalated") {
        // Same rung, second recipient set (the M19 on-call roster). A failure here retries the whole event;
        // the first alert is idempotent on its correlation id, so the retry never double-pages it.
        await alerts.emit(event.organizationId, {
          eventType: M20_CHECK_IN_ESCALATED_ONCALL_ALERT,
          severity: plan.severity,
          correlationId: `outbox:${M20_CHECK_IN_ESCALATED_ONCALL_ALERT}:${plan.correlationKey}`,
          payload: { ...plan.safe, eventType: M20_CHECK_IN_ESCALATED_ONCALL_ALERT },
        });
      }
    },
  };
}

export { planFor as planFieldSafetyAlert };
