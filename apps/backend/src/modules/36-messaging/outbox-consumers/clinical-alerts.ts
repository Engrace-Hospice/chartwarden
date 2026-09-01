import type { AlertEmitter, AlertSeverity } from "@wardenx/messaging";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";

const EVENT_TYPES = [
  "m17.visit.cancelled",
  "m17.visit.rescheduled",
  "m17.visit.no_show_detected",
  "m17.stale_visit_detected",
  "m17.time_off.requested",
  "m17.time_off.approved",
  "m17.time_off.denied",
  "m17.route_optimization_degraded",
  "m17.reassignment_needed",
  "m17.caregiver_reminder_due",
  "m8.encounter.signed",
  "m8.encounter.cosignature_routed",
  "m8.encounter.cosignature_overdue",
  "m8.encounter.cosignature_escalated",
  "m8.encounter.cosignature_hard_cap_reached",
  "m6.admission.discharged",
] as const;

function stringOrNull(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function severityFor(eventType: string): AlertSeverity {
  if (
    eventType === "m8.encounter.cosignature_hard_cap_reached" ||
    eventType === "m6.admission.discharged"
  ) {
    return "critical";
  }
  if (eventType === "m8.encounter.signed") return "info";
  return "warn";
}

function safePayload(eventType: string, payload: Record<string, unknown>): Record<string, unknown> {
  const visitId = stringOrNull(payload, "visitId");
  const encounterId = stringOrNull(payload, "encounterId");
  const patientId = stringOrNull(payload, "patientId");
  const admissionId = stringOrNull(payload, "admissionId");
  return {
    eventType,
    visitId,
    encounterId,
    patientId,
    admissionId,
    assignedMembershipId:
      stringOrNull(payload, "assignedMembershipId") ??
      stringOrNull(payload, "clinicianMembershipId") ??
      stringOrNull(payload, "routedToMembershipId"),
    deepLink: visitId
      ? `/scheduling/visits/${visitId}`
      : encounterId && patientId
        ? `/patients/${patientId}/encounters/${encounterId}`
        : eventType.startsWith("m8.encounter.cosignature")
          ? "/work/cosignatures"
          : "/",
    message: eventType.startsWith("m8.")
      ? "An encounter requires attention."
      : "A scheduled visit requires attention.",
  };
}

export function buildM36ClinicalAlertConsumer(alerts: AlertEmitter): OutboxConsumerBinding {
  return {
    consumerName: "m36.clinical-visit-encounter-alerts",
    consumerModule: "m36",
    eventTypes: EVENT_TYPES,
    async handle(event) {
      const payload = event.payload as Record<string, unknown>;
      await alerts.emit(event.organizationId, {
        eventType: event.eventType,
        severity: severityFor(event.eventType),
        correlationId: `outbox:${event.eventType}:${event.aggregateId}`,
        payload: safePayload(event.eventType, payload),
      });
    },
  };
}
