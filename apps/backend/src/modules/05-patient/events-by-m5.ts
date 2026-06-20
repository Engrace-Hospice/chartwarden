// apps/backend/src/modules/05-patient/events-by-m5.ts — Module 5's outbox-event contributions
// (M5-T10, spec §4.6). The 16 `m5.patient.*` events keyed on M5's own tables, under the `m5.`
// namespace (M01 D8 / M03 D9). check-fitness-gaps.ts scans this file for naming (`mN.<resource>.
// <verb>`), ownership (moduleOwner='m5'), and valid declared consumers (real module ids). The named
// cross-module consumers (M16 bereavement, M22 DocLens/redaction, M23 final claim, M28 FHIR, M29
// inbound-proposal expiry, M36 alert) subscribe when they land; the events are published now.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

/** Shared minimal payload core — every patient event carries the patient + org id. */
const corePatient = {
  patientId: Type.String({ minLength: 1 }),
  organizationId: Type.String({ minLength: 1 }),
};

export const M5_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m5.patient.created",
    moduleOwner: "m5",
    description: "A patient chart was created (after the §2.3 match pipeline cleared).",
    payloadSchema: Type.Object({ ...corePatient, mrn: Type.String({ minLength: 1 }) }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.updated",
    moduleOwner: "m5",
    description: "Patient demographics changed (e.g. an M29 proposal apply); carries the changed-field list.",
    payloadSchema: Type.Object({ ...corePatient, changed: Type.Array(Type.String()) }),
    declaredConsumers: ["m28"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.status_changed",
    moduleOwner: "m5",
    description: "Patient lifecycle status transition (prospective→active→discharged, etc.).",
    payloadSchema: Type.Object({ ...corePatient, fromStatus: Type.String(), toStatus: Type.String() }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.address_changed",
    moduleOwner: "m5",
    description: "An address was appended (D5); triggers re-geocode (M17) + Medicaid state recheck (M24).",
    payloadSchema: Type.Object({ ...corePatient, addressId: Type.String() }),
    declaredConsumers: ["m17", "m24"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.payer_changed",
    moduleOwner: "m5",
    description: "A coverage was added/updated/closed.",
    payloadSchema: Type.Object({ ...corePatient }),
    declaredConsumers: ["m23", "m24"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.assignment_created",
    moduleOwner: "m5",
    description: "A clinician was assigned to a patient (caseload cache invalidation).",
    payloadSchema: Type.Object({ ...corePatient, clinicianUserId: Type.String() }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.assignment_ended",
    moduleOwner: "m5",
    description: "A clinician was unassigned from a patient.",
    payloadSchema: Type.Object({ ...corePatient, clinicianUserId: Type.String() }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.privacy_flag_changed",
    moduleOwner: "m5",
    description: "The patient_privacy_flag_snapshot was recomputed (e.g. a SUD flag added) — redaction consumers refresh.",
    payloadSchema: Type.Object({ ...corePatient, flags: Type.Array(Type.String()) }),
    declaredConsumers: ["m22", "m28"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.deceased",
    moduleOwner: "m5",
    description: "Patient death recorded; seeds bereavement (M16), enables final claim (M23), FHIR sync (M28), IDG alert (M36).",
    payloadSchema: Type.Object({ ...corePatient, deceasedDate: Type.String() }),
    declaredConsumers: ["m16", "m23", "m28", "m36"],
    isOutboxOnly: false,
  },
  {
    eventName: "m5.patient.merged",
    moduleOwner: "m5",
    description: "Two charts merged; document re-attach (M22) + FHIR Patient.link write (M28).",
    payloadSchema: Type.Object({ ...corePatient, sourcePatientId: Type.String() }),
    declaredConsumers: ["m22", "m28"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.unmerged",
    moduleOwner: "m5",
    description: "A merge was reversed within the 30-day window.",
    payloadSchema: Type.Object({ ...corePatient, sourcePatientId: Type.String() }),
    declaredConsumers: ["m22", "m28"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.archived",
    moduleOwner: "m5",
    description: "A chart was archived; M29 expires related HL7 inbound proposals.",
    payloadSchema: Type.Object({ ...corePatient }),
    declaredConsumers: ["m29"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.amendment_request_received",
    moduleOwner: "m5",
    description: "A §164.526 amendment request was opened (60-day SLA started).",
    payloadSchema: Type.Object({ ...corePatient, amendmentId: Type.String() }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.amendment_decided",
    moduleOwner: "m5",
    description: "An amendment request was accepted or denied.",
    payloadSchema: Type.Object({ ...corePatient, amendmentId: Type.String(), decision: Type.String() }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.bereavement_opt_out_changed",
    moduleOwner: "m5",
    description: "Bereavement opt-out toggled; M16 bereavement-plan reconciler skips/closes plans (D9).",
    payloadSchema: Type.Object({ ...corePatient, optedOut: Type.Boolean() }),
    declaredConsumers: ["m16"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.draft_created_from_extraction",
    moduleOwner: "m5",
    description: "A draft patient was created from an M22 DocLens extraction commit.",
    payloadSchema: Type.Object({ ...corePatient }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
];
