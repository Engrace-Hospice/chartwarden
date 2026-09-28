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
    description:
      "Patient demographics changed (e.g. an M29 proposal apply); carries the changed-field list.",
    payloadSchema: Type.Object({ ...corePatient, changed: Type.Array(Type.String()) }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035; M28's Patient projection reads
    // this live at request time via `PatientReader`).
    // F-140 (#248) — m24 ADDED: M24's own authoritative `M24_SUBSCRIPTION_MAP` names this event with a
    // real handler (`trigger-revalidate` → `handleUpstreamChange`), re-validating a claim on any
    // upstream demographic change.
    declaredConsumers: ["m24"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.status_changed",
    moduleOwner: "m5",
    description: "Patient lifecycle status transition (prospective→active→discharged, etc.).",
    payloadSchema: Type.Object({
      ...corePatient,
      fromStatus: Type.String(),
      toStatus: Type.String(),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.address_changed",
    moduleOwner: "m5",
    description:
      "An address was appended (D5); triggers re-geocode (M5's own geocode job) + Medicaid state recheck (M24).",
    payloadSchema: Type.Object({ ...corePatient, addressId: Type.String() }),
    // F-133 (#248) — the re-geocode is M5's OWN internal `m5.geocode_address` job
    // (jobs/index.ts), not M17: M17's own spec (§7.10) says outright "M17 NEVER geocodes;
    // geocoding requests are M5's geocode job which runs on `patient.address_changed`
    // outbox" — M17 only ever reads the result afterward via the `PatientAddressReader`
    // seam PULL (`coordsForAddress`), never this push event.
    declaredConsumers: ["m24"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.payer_changed",
    moduleOwner: "m5",
    description: "A coverage was added/updated/closed.",
    payloadSchema: Type.Object({ ...corePatient }),
    // F-136 (#248) — m23 REMOVED: M23's own spec describes `patient_payer` ranking + `coverage_kind` as
    // CONSULTED (a seam pull) fresh at every claim assembly, never a push subscription — the next
    // assembly picks up a payer change on its own, so there is nothing for a push event to invalidate.
    // F-140 (#248) — m24 REMOVED: the identical shape one module over — redundant with
    // `PatientPayerReader.coverageKindOn()`, a seam consumed at claim assembly (M24's own spec, the same
    // D5/D10 substrate M23 reuses); not in `M24_SUBSCRIPTION_MAP`.
    declaredConsumers: [],
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
    description:
      "The patient_privacy_flag_snapshot was recomputed (e.g. a SUD flag added) — redaction consumers refresh.",
    payloadSchema: Type.Object({ ...corePatient, flags: Type.Array(Type.String()) }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035; SUD redaction is applied fresh
    // per read at D3 egress, not via a cached flag this event would invalidate).
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.deceased",
    moduleOwner: "m5",
    description:
      "Patient death recorded (this module's own §7.8 death cascade, itself a consumer of M6's `m6.discharge.death` — a third hop from the real bereavement handshake); enables final claim (M23), FHIR sync (M28, F-115/#248: at request time, not via this event), IDG alert (M36).",
    payloadSchema: Type.Object({ ...corePatient, deceasedDate: Type.String() }),
    // F-134 (#248) — `m16` removed: F-105 established `m6.bereavement.eligible` (emitted synchronously
    // in M6's own death-discharge transaction) is the ONLY path a `bereavement_plan` row can come into
    // existence; this event is a downstream reaction to that SAME transaction two hops later and carries
    // no fact M16's intake decider (`consumers/m6-eligibility.ts`) reads.
    // F-141 (#248) — m29 ADDED: M29's own spec is decisive and explicit — "`m5.patient.deceased`
    // consumed via outbox to freeze inbound ADT processing for the decedent and to refuse any
    // post-death A01/A04 events with a typed OperationOutcome" — genuinely undeclared until now.
    // F-142 (#248) — m35 ADDED: M35's own D21 (locked, exhaustive) names this event among its 8
    // inbound subscriptions ("skipping `m5.patient.merged` — leaves pseudonym aggregates wrong
    // post-merge" is D21's own rejected-alternative text for the sibling below, and `deceased` is a
    // peer in the same D21 list).
    declaredConsumers: ["m23", "m29", "m35"],
    seamConsumers: ["m36"],
    isOutboxOnly: false,
  },
  {
    eventName: "m5.patient.merged",
    moduleOwner: "m5",
    description:
      "Two charts merged; document re-attach (M22) + FHIR Patient.link projection (M28, F-115/#248: at request time, not via this event).",
    payloadSchema: Type.Object({ ...corePatient, sourcePatientId: Type.String() }),
    // F-142 (#248) — m35 added: M35's own D21 (locked) names this event explicitly, with its own
    // rejected-alternative text spelling out why: "skipping `m5.patient.merged` — leaves pseudonym
    // aggregates wrong post-merge."
    declaredConsumers: ["m22", "m35"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.unmerged",
    moduleOwner: "m5",
    description: "A merge was reversed within the 30-day window.",
    payloadSchema: Type.Object({ ...corePatient, sourcePatientId: Type.String() }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.archived",
    moduleOwner: "m5",
    description: "A chart was archived.",
    payloadSchema: Type.Object({ ...corePatient }),
    // F-141 (#248) — m29 dropped: this event's own description claimed "M29 expires related HL7 inbound
    // proposals" — no support anywhere in M29's spec (zero mentions of patient archival; M29's own
    // proposal-lifecycle documentation names exactly one expiry path, the 72h SLA timer). Record-only.
    declaredConsumers: [],
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
    payloadSchema: Type.Object({
      ...corePatient,
      amendmentId: Type.String(),
      decision: Type.String(),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.bereavement_opt_out_changed",
    moduleOwner: "m5",
    description:
      "Bereavement opt-out toggled; M16 bereavement-plan reconciler skips/closes plans (D9).",
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
