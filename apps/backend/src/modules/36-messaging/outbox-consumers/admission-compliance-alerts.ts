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
import type { AlertEmitter } from "@chartwarden/messaging";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

export const M36_ADMISSION_COMPLIANCE_ALERT_CONSUMER = "m36.admission-compliance-alerts" as const;

export const M36_ADMISSION_COMPLIANCE_ALERT_EVENT_TYPES = [
  "m6.election_addendum.overdue",
  "m6.compliance.window.overdue",
  // Milestone 10a — NOMNC / BFCC-QIO expedited review: a review opened, a typed deadline near or past.
  "m6.expedited_review.opened",
  "m6.expedited_deadline.approaching",
  "m6.expedited_deadline.overdue",
] as const;

/** Window kinds whose miss is paged by the dedicated addendum event instead (never double-page). */
const ADDENDUM_WINDOW_KINDS_PAGED_ELSEWHERE: ReadonlySet<string> = new Set([
  "election_addendum_initial",
  "election_addendum_update",
]);

const WINDOW_KIND_LABEL: Readonly<Record<string, string>> = {
  initial_assessment_48h: "initial assessment (48 hours)",
  comprehensive_assessment_5d: "comprehensive assessment (5 days)",
  care_plan_5d: "plan of care (5 days)",
  f2f_recert_30d_prior: "face-to-face encounter (recertification)",
  recert_due_14d: "recertification",
  recert_due_7d: "recertification",
  cti_signature_lookahead_14d: "certification of terminal illness",
  notice_of_rights: "notice of rights",
};

function planWindowOverdue(
  p: Record<string, unknown>,
  name: string,
): AdmissionComplianceAlertPlan[] {
  // Legacy emissions (pre GAP-026) carry no routing facts: nothing to route on, nothing to page.
  if (typeof p.windowKind !== "string" || typeof p.patientId !== "string") return [];
  if (ADDENDUM_WINDOW_KINDS_PAGED_ELSEWHERE.has(p.windowKind)) return [];
  const windowId = requireString(p, "complianceWindowId", name);
  const patientId = p.patientId;
  const windowKind = p.windowKind;
  const safe = {
    patientId,
    admissionId: requireString(p, "admissionId", name),
    complianceWindowId: windowId,
    windowKind,
    dueAt: requireString(p, "dueAt", name),
    deepLink: `/patients/${patientId}/election-certification`,
    message: `The ${WINDOW_KIND_LABEL[windowKind] ?? windowKind} compliance window passed its due time without being completed.`,
  };
  return [
    { alertEventType: "m6.compliance.window.overdue", correlationKey: `${windowId}:team`, safe },
    {
      alertEventType: "m6.compliance.window.overdue_compliance",
      correlationKey: `${windowId}:compliance`,
      safe,
    },
  ];
}

const EXPEDITED_KIND_LABEL: Readonly<Record<string, string>> = {
  appeal_request: "appeal request",
  denc_delivery: "DENC delivery",
  records_to_qio: "records to the QIO",
  qio_decision: "QIO decision",
  other: "recorded",
};

/** Two audiences per code (care team, then compliance + clinical lead + billing), distinct correlation keys. */
function twoAudiences(
  alertEventType: string,
  key: string,
  safe: Record<string, unknown>,
): AdmissionComplianceAlertPlan[] {
  return [
    { alertEventType, correlationKey: `${key}:team`, safe },
    { alertEventType: `${alertEventType}_compliance`, correlationKey: `${key}:compliance`, safe },
  ];
}

/** Milestone 10a. NO PHI and NO rule statement: ids, the deadline kind and instants, and what staff recorded. */
function planExpedited(p: Record<string, unknown>, name: string): AdmissionComplianceAlertPlan[] {
  const patientId = requireString(p, "patientId", name);
  const admissionId = requireString(p, "admissionId", name);
  const deepLink = `/admissions/${admissionId}`;
  if (name === "m6.expedited_review.opened") {
    const reviewId = requireString(p, "expeditedReviewId", name);
    return twoAudiences(name, reviewId, {
      patientId,
      admissionId,
      expeditedReviewId: reviewId,
      nomncNoticeId: requireString(p, "nomncNoticeId", name),
      qioNotifiedAt: requireString(p, "qioNotifiedAt", name),
      deepLink,
      message:
        "A QIO expedited review was opened for a NOMNC. Open the admission and enter the deadlines the QIO gave, with their source.",
    });
  }
  const deadlineId = requireString(p, "expeditedDeadlineId", name);
  const kind = requireString(p, "kind", name);
  const label = EXPEDITED_KIND_LABEL[kind] ?? kind;
  const base = {
    patientId,
    admissionId,
    expeditedDeadlineId: deadlineId,
    subject: requireString(p, "subject", name),
    kind,
    dueAt: requireString(p, "dueAt", name),
    deepLink,
  };
  if (name === "m6.expedited_deadline.approaching") {
    const hours = p.boundaryHours;
    if (typeof hours !== "number") {
      throw new Error(
        `${M36_ADMISSION_COMPLIANCE_ALERT_CONSUMER}: ${name} payload has no boundaryHours`,
      );
    }
    return twoAudiences(name, `${deadlineId}:${hours}`, {
      ...base,
      boundaryHours: hours,
      message: `The recorded ${label} deadline is within ${hours} hour${hours === 1 ? "" : "s"} and is not marked met.`,
    });
  }
  return twoAudiences(name, `${deadlineId}:overdue`, {
    ...base,
    message: `The recorded ${label} deadline has passed and is not marked met.`,
  });
}

export interface AdmissionComplianceAlertPlan {
  readonly alertEventType: string;
  readonly correlationKey: string;
  readonly safe: Record<string, unknown>;
}

function requireString(p: Record<string, unknown>, key: string, eventName: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      `${M36_ADMISSION_COMPLIANCE_ALERT_CONSUMER}: ${eventName} payload has no ${key}`,
    );
  }
  return v;
}

/** Pure: the alerts one delivered event raises. */
export function planAdmissionComplianceAlerts(
  event: Pick<DispatchableOutboxEvent, "eventType" | "payload">,
): AdmissionComplianceAlertPlan[] {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const name = event.eventType;
  if (name === "m6.compliance.window.overdue") return planWindowOverdue(p, name);
  if (name.startsWith("m6.expedited_")) return planExpedited(p, name);
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
