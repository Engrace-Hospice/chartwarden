// apps/backend/src/modules/36-messaging/outbox-consumers/emar-alerts.ts — M36's consumer of M13's deadline /
// detection events (GAP-039 missed dose, GAP-040 PRN reassessment overdue + the §2.8/§2.7 deadline crons).
// M13 spec §4.9 names these as typed M36 alerts; until now nothing consumed them (M36 sat on the
// seam-consumer list), so a missed dose, an uncaptured PRN reassessment, a late reconciliation and an
// unreturned comfort kit all raised nothing.
//
//   event (M13 outbox)                   -> alert eventType (platform `alert_rule`)   severity
//   m13.scheduled_dose.missed            -> emar.dose_missed                           critical if controlled, else warn
//   m13.prn_reassessment.overdue         -> m13.prn_reassessment.overdue               warn
//   m13.reconciliation.due_at_warning    -> m13.reconciliation.due_at_warning          warn
//   m13.reconciliation.overdue           -> m13.reconciliation.overdue                 critical
//   m13.comfort_kit.return_overdue       -> m13.comfort_kit.return_overdue             critical
//
// RECIPIENTS: each alert type has a platform `alert_rule` (packages/messaging seed) resolving the patient's
// care team via the payload's `patientId`. M36 never imports M13 — events are matched by name.
//
// IDEMPOTENCY: every alert has a deterministic correlation id and `alert` is UNIQUE on
// (organization_id, correlation_id), so a relay redelivery or a cron retry can never page twice.
//
// NO PHI: ids, instants and counts only (no drug name, no reason text). A malformed event THROWS (relay retry
// -> DLQ — a visible failure, never a silently dropped alert).
import type { AlertEmitter, AlertSeverity } from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_EMAR_ALERT_CONSUMER = "m36.emar-alerts" as const;

interface EmarAlertPlan {
  readonly alertEventType: string;
  readonly severity: AlertSeverity;
  readonly correlationKey: string;
  readonly safe: Record<string, unknown>;
}

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${M36_EMAR_ALERT_CONSUMER}: ${eventName} payload has no ${key}`);
  }
  return v;
}

function planFor(event: DispatchableOutboxEvent): EmarAlertPlan {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const name = event.eventType;
  const patientId = requireString(p, "patientId", name);
  const patientLink = `/patients/${patientId}`;
  switch (name) {
    case "m13.scheduled_dose.missed":
      return {
        alertEventType: "emar.dose_missed",
        severity: p.isControlled === true ? "critical" : "warn",
        correlationKey: requireString(p, "scheduledDoseId", name),
        safe: {
          patientId,
          medicationOrderId: p.medicationOrderId,
          scheduledDoseId: p.scheduledDoseId,
          missedDoseId: p.missedDoseId,
          dueAt: p.dueAt,
          isControlled: p.isControlled === true,
          deepLink: `${patientLink}/emar`,
          message: "A scheduled medication dose was not administered within its grace window.",
        },
      };
    case "m13.prn_reassessment.overdue":
      return {
        alertEventType: name,
        severity: "warn",
        correlationKey: requireString(p, "prnAdministrationId", name),
        safe: {
          patientId,
          medicationOrderId: p.medicationOrderId,
          prnAdministrationId: p.prnAdministrationId,
          recommendedReassessmentScale: p.recommendedReassessmentScale,
          reassessmentDueAt: p.reassessmentDueAt,
          deepLink: `${patientLink}/emar`,
          message: "A PRN medication reassessment is overdue.",
        },
      };
    case "m13.reconciliation.due_at_warning":
    case "m13.reconciliation.overdue":
      return {
        alertEventType: name,
        severity: name === "m13.reconciliation.overdue" ? "critical" : "warn",
        correlationKey: requireString(p, "worksheetId", name),
        safe: {
          patientId,
          worksheetId: p.worksheetId,
          triggerKind: p.triggerKind,
          dueAt: p.dueAt,
          deepLink: `${patientLink}/emar`,
          message:
            name === "m13.reconciliation.overdue"
              ? "A medication reconciliation worksheet is overdue."
              : "A medication reconciliation worksheet is due within 24 hours.",
        },
      };
    case "m13.comfort_kit.return_overdue":
      return {
        alertEventType: name,
        severity: "critical",
        // Daily nag by design: `daysOverdue` is part of the key so each day is one alert, never two.
        correlationKey: `${requireString(p, "deploymentId", name)}:${String(p.daysOverdue)}`,
        safe: {
          patientId,
          deploymentId: p.deploymentId,
          daysOverdue: p.daysOverdue,
          deepLink: `${patientLink}/emar`,
          message: "A comfort kit has not been returned within the compliance window.",
        },
      };
    default:
      throw new Error(`${M36_EMAR_ALERT_CONSUMER}: unexpected event ${name}`);
  }
}

export const M36_EMAR_ALERT_EVENT_TYPES = [
  "m13.scheduled_dose.missed",
  "m13.prn_reassessment.overdue",
  "m13.reconciliation.due_at_warning",
  "m13.reconciliation.overdue",
  "m13.comfort_kit.return_overdue",
] as const;

export function buildM36EmarAlertConsumer(alerts: AlertEmitter): OutboxConsumerBinding {
  return {
    consumerName: M36_EMAR_ALERT_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_EMAR_ALERT_EVENT_TYPES,
    async handle(event) {
      const plan = planFor(event);
      await alerts.emit(event.organizationId, {
        eventType: plan.alertEventType,
        severity: plan.severity,
        correlationId: `outbox:${event.eventType}:${plan.correlationKey}`,
        payload: { eventType: event.eventType, ...plan.safe },
      });
    },
  };
}

export { planFor as planEmarAlert };
