// apps/backend/src/modules/36-messaging/outbox-consumers/patient-lifecycle-review.ts - WP 3.8 (ADR-0065 D3): when a patient is
// discharged, dies or transfers out, queue their OPEN care-team communication tasks for a supervisor's decision and tell the
// people affected. The archive of the care_team channel is a different consumer (GAP-104 channel-membership-sync); this one
// never touches a message, a channel or a task - it only records review rows and raises in-app alerts.
//
//   m6.admission.discharged -> cause by reason (death | transfer | discharge); patient via M6's AdmissionStatusReader;
//                              SKIPPED when M6 reports another admission under care (a late/redelivered discharge of a
//                              readmitted patient, the same guard M5's consumer uses). A death is never skipped.
//   m5.patient.deceased     -> cause death (also reached when M5 records a death without M6)
//
// An M6 death arrives twice (the discharge, then M5's cascade): both queue under the SAME trigger (the patient id), so the
// rows and the alert correlation ids converge. TENANT: from the envelope only. A malformed payload or an admission that does
// not resolve THROWS (relay retry -> DLQ), never a silently unreviewed patient. The queue is a safety record, so rows are
// written whether or not the `messaging.tasks` flag is on; alerts honour the flag. Logs carry ids and enums only.
import type { AlertEmitter } from "@wardenx/messaging";
import { lifecycleCause, triggerRefFor } from "@wardenx/messaging";
import type { ReviewLifecycleCause } from "@wardenx/types";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { LIFECYCLE_SOURCE } from "../review/lifecycle-queue";
import {
  type ReviewWarn,
  emitReviewQueuedAlert,
  emitTaskNeedsDecisionAlerts,
} from "../review/review-alerts";

export const M36_PATIENT_LIFECYCLE_REVIEW_CONSUMER = "m36.patient-lifecycle-review" as const;

export const M36_PATIENT_LIFECYCLE_REVIEW_EVENT_TYPES = [
  "m6.admission.discharged",
  "m5.patient.deceased",
] as const;

export interface AdmissionCare {
  readonly patientId: string;
  /** True iff another admission of the same patient is still under care (active / on hold). */
  readonly otherAdmissionUnderCare: boolean;
}

export interface PatientLifecycleReviewDeps {
  readonly alerts: AlertEmitter;
  /** M6 AdmissionStatusReader.getAdmissionPatientCare, org-explicit; null when the admission is unknown. */
  readonly admissionCare: (orgId: string, admissionId: string) => Promise<AdmissionCare | null>;
  /** The review binding's port: queue the patient's open care-team tasks; who holds an OPEN review of this trigger. */
  readonly queueForPatient: (
    orgId: string,
    trigger: { cause: ReviewLifecycleCause; triggerRef: string; patientId: string },
  ) => Promise<{ openSubjects: string[] }>;
  /** The `messaging.tasks` tenant flag; a throw reads as off (alerts only - the rows are queued regardless). */
  readonly isFlagOn: (orgId: string) => Promise<boolean>;
  readonly warn?: ReviewWarn | undefined;
}

function requireString(payload: Record<string, unknown>, key: string, eventType: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M36_PATIENT_LIFECYCLE_REVIEW_CONSUMER}: ${eventType} payload has no ${key}`);
  }
  return value;
}

interface Resolved {
  readonly cause: ReviewLifecycleCause;
  readonly patientId: string;
  readonly triggerRef: string;
}

/** The trigger this event stands for, or null when it must be skipped (readmitted patient on a late discharge). */
async function resolve(
  event: DispatchableOutboxEvent,
  deps: PatientLifecycleReviewDeps,
): Promise<Resolved | null> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const orgId = event.organizationId;
  if (event.eventType === "m5.patient.deceased") {
    const patientId = requireString(payload, "patientId", event.eventType);
    return { cause: "death", patientId, triggerRef: patientId };
  }
  const admissionId = requireString(payload, "admissionId", event.eventType);
  const reason = typeof payload.reason === "string" ? payload.reason : undefined;
  const cause = lifecycleCause(event.eventType, reason);
  const care = await deps.admissionCare(orgId, admissionId);
  if (!cause || !care) {
    throw new Error(
      `${M36_PATIENT_LIFECYCLE_REVIEW_CONSUMER}: admission ${admissionId} does not resolve to a patient`,
    );
  }
  if (cause !== "death" && care.otherAdmissionUnderCare) return null;
  const triggerRef = triggerRefFor(cause, { patientId: care.patientId, admissionId });
  if (!triggerRef)
    throw new Error(`${M36_PATIENT_LIFECYCLE_REVIEW_CONSUMER}: no trigger reference`);
  return { cause, patientId: care.patientId, triggerRef };
}

async function handleEvent(
  event: DispatchableOutboxEvent,
  deps: PatientLifecycleReviewDeps,
): Promise<void> {
  const trigger = await resolve(event, deps);
  if (!trigger) return;
  const orgId = event.organizationId;
  const { openSubjects } = await deps.queueForPatient(orgId, trigger);
  if (openSubjects.length === 0) return;
  if (!(await deps.isFlagOn(orgId).catch(() => false))) return;
  const alertTrigger = { source: LIFECYCLE_SOURCE, triggerRef: trigger.triggerRef };
  const alertDeps = { alerts: deps.alerts, warn: deps.warn };
  await emitReviewQueuedAlert(alertDeps, orgId, alertTrigger);
  await emitTaskNeedsDecisionAlerts(alertDeps, orgId, alertTrigger, openSubjects);
}

export function buildM36PatientLifecycleReviewConsumer(
  deps: PatientLifecycleReviewDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M36_PATIENT_LIFECYCLE_REVIEW_CONSUMER,
    consumerModule: "m36",
    eventTypes: M36_PATIENT_LIFECYCLE_REVIEW_EVENT_TYPES,
    handle: (event) => handleEvent(event, deps),
  };
}
