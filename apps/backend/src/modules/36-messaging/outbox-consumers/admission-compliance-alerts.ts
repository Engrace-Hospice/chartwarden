// apps/backend/src/modules/36-messaging/outbox-consumers/admission-compliance-alerts.ts — FY2027 (CMS-1851-F).
// M36's consumer of M6's election-addendum overdue event. Until now no `m6.compliance.window.*` fact reached
// anyone (the generic window events carry no patient and have no consumer, F-178/F-179); the addendum is a
// condition for payment, so its 42 CFR 418.24(d) miss pages two audiences:
//
//   m6.election_addendum.overdue -> alert `m6.election_addendum.overdue`             (care team, warn)
//                                -> alert `m6.election_addendum.overdue_compliance`  (compliance + clinical lead, warn)
//
// RECIPIENTS come from the platform `alert_rule` rows (packages/messaging seed). M36 never imports M6 — the
// event is matched by name. IDEMPOTENCY: one deterministic correlation id per (window, audience), and `alert`
// is UNIQUE on (organization_id, correlation_id), so a redelivery never pages twice. NO PHI: ids, the window
// kind and the due instant only. A malformed event THROWS (retry → DLQ, never a silently dropped alert).
import type { AlertEmitter } from "@wardenx/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_ADMISSION_COMPLIANCE_ALERT_CONSUMER = "m36.admission-compliance-alerts" as const;

export const M36_ADMISSION_COMPLIANCE_ALERT_EVENT_TYPES = ["m6.election_addendum.overdue"] as const;

export interface AdmissionComplianceAlertPlan {
  readonly alertEventType: string;
  readonly correlationKey: string;
  readonly safe: Record<string, unknown>;
}

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${M36_ADMISSION_COMPLIANCE_ALERT_CONSUMER}: ${eventName} payload has no ${key}`);
  }
  return v;
}

/** Pure: the alerts one delivered event raises. */
export function planAdmissionComplianceAlerts(
  event: Pick<DispatchableOutboxEvent, "eventType" | "payload">,
): AdmissionComplianceAlertPlan[] {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const name = event.eventType;
  if (name !== "m6.election_addendum.overdue") {
    throw new Error(`${M36_ADMISSION_COMPLIANCE_ALERT_CONSUMER}: unexpected event ${name}`);
  }
  const windowId = requireString(p, "complianceWindowId", name);
  const patientId = requireString(p, "patientId", name);
  const admissionId = requireString(p, "admissionId", name);
  const windowKind = requireString(p, "windowKind", name);
  const update = windowKind === "election_addendum_update";
  const safe = {
    patientId,
    admissionId,
    complianceWindowId: windowId,
    electionAddendumId: typeof p.electionAddendumId === "string" ? p.electionAddendumId : null,
    windowKind,
    dueAt: requireString(p, "dueAt", name),
    deepLink: `/patients/${patientId}/election-certification`,
    message: update
      ? "The updated election statement addendum was not furnished within 3 days of the plan of care change (42 CFR 418.24(d)(2))."
      : "The election statement addendum was not furnished within 5 days of the election's effective date (42 CFR 418.24(d)(1)).",
  };
  return [
    { alertEventType: "m6.election_addendum.overdue", correlationKey: `${windowId}:team`, safe },
    {
      alertEventType: "m6.election_addendum.overdue_compliance",
      correlationKey: `${windowId}:compliance`,
      safe,
    },
  ];
}

export function buildM36AdmissionComplianceAlertConsumer(
  alerts: AlertEmitter,
): OutboxConsumerBinding {
  return {
    consumerName: M36_ADMISSION_COMPLIANCE_ALERT_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_ADMISSION_COMPLIANCE_ALERT_EVENT_TYPES,
    async handle(event) {
      for (const plan of planAdmissionComplianceAlerts(event)) {
        await alerts.emit(event.organizationId, {
          eventType: plan.alertEventType,
          severity: "warn",
          correlationId: `outbox:${event.eventType}:${plan.correlationKey}`,
          payload: { eventType: event.eventType, ...plan.safe },
        });
      }
    },
  };
}
