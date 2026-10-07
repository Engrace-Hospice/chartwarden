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

/**
 * M36 owns alert delivery, not each module's navigation taxonomy. This consumer is the one
 * exception: it deliberately binds several established cross-module event families, so keep the
 * presentation next to their event-specific facts rather than falling through to the home page.
 */
export function presentationForClinicalEvent(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const visitId = stringOrNull(payload, "visitId");
  const encounterId = stringOrNull(payload, "encounterId");
  const patientId = stringOrNull(payload, "patientId");
  const admissionId = stringOrNull(payload, "admissionId");
  const base = {
    eventType,
    visitId,
    encounterId,
    patientId,
    admissionId,
    assignedMembershipId:
      stringOrNull(payload, "assignedMembershipId") ??
      stringOrNull(payload, "clinicianMembershipId") ??
      stringOrNull(payload, "routedToMembershipId"),
  };

  switch (eventType) {
    case "m17.visit.cancelled":
      return {
        ...base,
        deepLink: visitId ? `/scheduling/visits/${visitId}` : undefined,
        message: "A scheduled visit was cancelled.",
      };
    case "m17.visit.rescheduled":
      return {
        ...base,
        deepLink: visitId ? `/scheduling/visits/${visitId}` : undefined,
        message: "A scheduled visit was rescheduled.",
      };
    case "m17.visit.no_show_detected":
      return {
        ...base,
        deepLink: visitId ? `/scheduling/visits/${visitId}` : undefined,
        message: "A scheduled visit was marked as a no-show.",
      };
    case "m17.stale_visit_detected":
      return {
        ...base,
        deepLink: visitId ? `/scheduling/visits/${visitId}` : undefined,
        message: "A scheduled visit needs review.",
      };
    case "m17.reassignment_needed":
      return {
        ...base,
        deepLink: visitId ? `/scheduling/visits/${visitId}` : undefined,
        message: "A scheduled visit needs reassignment.",
      };
    case "m17.caregiver_reminder_due":
      return {
        ...base,
        deepLink: visitId ? `/scheduling/visits/${visitId}` : undefined,
        message: "A caregiver visit reminder is due.",
      };
    case "m17.time_off.requested":
      return {
        ...base,
        deepLink: "/scheduling/time-off",
        message: "A time-off request requires review.",
      };
    case "m17.time_off.approved":
      return {
        ...base,
        deepLink: "/scheduling/time-off",
        message: "A time-off request was approved.",
      };
    case "m17.time_off.denied":
      return {
        ...base,
        deepLink: "/scheduling/time-off",
        message: "A time-off request was denied.",
      };
    case "m17.route_optimization_degraded":
      return {
        ...base,
        deepLink: "/scheduling/day",
        message: "Route optimization is unavailable; the scheduling day view is using its fallback order.",
      };
    case "m8.encounter.signed":
      return {
        ...base,
        deepLink:
          encounterId && patientId ? `/patients/${patientId}/encounters/${encounterId}` : undefined,
        message: "An encounter was signed.",
      };
    case "m8.encounter.cosignature_routed":
      return {
        ...base,
        deepLink: "/work/cosignatures",
        message: "An encounter cosignature was routed for review.",
      };
    case "m8.encounter.cosignature_overdue":
      return {
        ...base,
        deepLink: "/work/cosignatures",
        message: "An encounter cosignature is overdue.",
      };
    case "m8.encounter.cosignature_escalated":
      return {
        ...base,
        deepLink: "/work/cosignatures",
        message: "An encounter cosignature has escalated.",
      };
    case "m8.encounter.cosignature_hard_cap_reached":
      return {
        ...base,
        deepLink: "/work/cosignatures",
        message: "An encounter cosignature reached its required escalation limit.",
      };
    case "m6.admission.discharged":
      return {
        ...base,
        deepLink: admissionId ? `/admissions/${admissionId}` : undefined,
        message: "An admission has been discharged.",
      };
    default:
      return { ...base, message: "A clinical alert requires attention." };
  }
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
        payload: presentationForClinicalEvent(event.eventType, payload),
      });
    },
  };
}
