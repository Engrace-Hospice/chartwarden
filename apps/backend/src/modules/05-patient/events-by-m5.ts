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
    // F-143 (#248) — m12 ADDED: M12's own live `M12_OUTBOX_SUBSCRIPTIONS` list (consumers/index.ts)
    // names this event for `m12.patient-sync-created`, backed by a real pure decider
    // (`decidePatientSyncTrigger`, sync-triggers.ts) per M12's D4 — the DoseSpot patient sync.
    declaredConsumers: ["m12"],
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
    // F-143 (#248) — m12 ADDED: M12's own live `M12_OUTBOX_SUBSCRIPTIONS` list names this event for
    // `m12.patient-sync-updated` (D4).
    declaredConsumers: ["m24", "m12"],
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
    // F-143 (#248) — m12 ADDED: M12's own live `M12_OUTBOX_SUBSCRIPTIONS` list names this event for
    // `m12.patient-sync-address-changed` (D4).
    // GAP-118 — m5 ADDED: the re-geocode is now a real consumer (`outbox-consumers/m5-geocode-address.ts`).
    declaredConsumers: ["m24", "m12", "m5"],
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
    // F-143 (#248) — m12 ADDED: M12's own live `M12_OUTBOX_SUBSCRIPTIONS` list names this event for
    // `m12.patient-sync-payer-changed` (D4, RxBenefit cache invalidation) — unlike M23/M24, M12 has a
    // real still-unbound consumer for a payer change.
    declaredConsumers: ["m12"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.assignment_created",
    moduleOwner: "m5",
    description: "A clinician was assigned to a patient (caseload cache invalidation).",
    payloadSchema: Type.Object({
      ...corePatient,
      clinicianUserId: Type.String(),
      role: Type.String(),
    }),
    // GAP-104 — m36 ADDED: `m36.channel-membership-sync` re-syncs the care_team channel roster.
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.assignment_ended",
    moduleOwner: "m5",
    description: "A clinician was unassigned from a patient.",
    payloadSchema: Type.Object({
      ...corePatient,
      clinicianUserId: Type.String(),
      role: Type.String(),
    }),
    // GAP-104 — m36 ADDED: `m36.channel-membership-sync` re-syncs the care_team channel roster.
    declaredConsumers: ["m36"],
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
    // F-144 (#248) — m22 removed: the identical shape one module over — M22's own spec (dependsOn text)
    // states the privacy-flag snapshot is "consulted via M3's `sud_consent_present` predicate" fresh per
    // read, not via a cached value this event would invalidate.
    declaredConsumers: [],
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
    // F-160 (#248) — m26 ADDED: M26's own `consumers/subscription-map.ts` (`M26_SUBSCRIPTION_MAP`)
    // routes this topic to `freeze-patient` — the identical action, over the identical handler
    // (`handleFreeze`), as the already-bound `m6.revocation.created` — to freeze the per-patient
    // extrapolation denominator at death. Real routing logic, now live-bound in
    // `26-cap/consumers/outbox-binding.ts`'s `BOUND_TOPICS`.
    // GAP-110 — m39 ADDED: M39's own spec (§4.6, §7.7 W-CON-07 step 3, job `m39-m5-patient-deceased`) names
    // this event with a real consumer (`39-consent/m5-patient-deceased-consumer.ts`) that expires the
    // decedent's active non-survives-death consents (D13) — an outbox push, not a `PatientReader` pull.
    // GAP-071 — m24 ADDED: M24 §4.4 `m5-patient-deceased.consumer.ts` voids the decedent's not-yet-billed
    // `rb_day` rows after the date of death ("final R&B day finalization").
    // GAP-104 — m36 MOVED from seamConsumers to declaredConsumers: `m36.channel-membership-sync` archives the
    // decedent's care_team channel (M36 spec §2.3 "auto-archived on discharge").
    // GAP-135 — m20 ADDED: M20's own §4.4 `m5-patient-deceased.consumer` closes the decedent's open safety
    // obligations (`20-field-safety/consumers/m5-patient-deceased.ts`, bound in `consumers/bindings.ts`).
    // WP 3.8 - m36 now has TWO consumers of this event: `m36.channel-membership-sync` (archive) and
    // `m36.patient-lifecycle-review` (queues the decedent's open care-team tasks for a supervisor). declaredConsumers is unchanged.
    declaredConsumers: ["m20", "m23", "m24", "m26", "m29", "m35", "m36", "m39"],
    isOutboxOnly: false,
  },
  {
    eventName: "m5.patient.merged",
    moduleOwner: "m5",
    description:
      "Two charts merged (`patientId` = the SURVIVOR/target, `sourcePatientId` = the duplicate folded away); FHIR Patient.link projection (M28, F-115/#248: at request time, not via this event). Real producer: `merges-db.ts`'s `mergePatients` (F-171, #248) — the §4.3 direct-merge route.",
    payloadSchema: Type.Object({ ...corePatient, sourcePatientId: Type.String() }),
    // F-142 (#248) — m35 added: M35's own D21 (locked) names this event explicitly, with its own
    // rejected-alternative text spelling out why: "skipping `m5.patient.merged` — leaves pseudonym
    // aggregates wrong post-merge."
    // F-171 (#248) — m22 MOVED to seamConsumers, not dropped: `22-documents/lifecycle/merge-redirect.ts`
    // (`resolvePatientRedirect`/`applyPatientMergeCascade`, M22-T03) is a complete, unit-tested pure core
    // whose OWN header states the real design — "M22 does NOT mutate `document.patient_id` eagerly on
    // the merge event in the read path — on every fetch it resolves the document's stored `patient_id`
    // through the merge chain to the surviving patient" — a SEAM PULL against live `patient.merged_into_id`
    // state, never a push. The `outbox-deferred-consumers.ts` m22 group's prior framing ("a real per-
    // document `UPDATE document SET patient_id = ...` M22 would have to perform") was checked against
    // this file directly and found wrong: no such write exists or is designed, and this pure core has
    // zero real callers anywhere in `22-documents/` (grepped outside its own barrel export + unit test) —
    // the read-time redirect is itself still unwired (a real, separate M22-owned gap: a DB-backed
    // `MergeFacts` + threading it through M22's document-fetch routes), reported here rather than built,
    // since it touches M22's read surface broadly and is not an outbox-consumer build.
    // GAP-067 — m39 ADDED: M39 spec §4.6 re-points consent_record.patient_id (Part 2 releases and revocations
    // included) to the survivor (`39-consent/m5-patient-merged-consumer.ts`), emitting `m39.consent.repointed`.
    declaredConsumers: ["m35", "m39"],
    seamConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.unmerged",
    moduleOwner: "m5",
    description: "A merge was reversed within the 30-day window.",
    payloadSchema: Type.Object({ ...corePatient, sourcePatientId: Type.String() }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035).
    // F-144 (#248) — m22 removed: M5's own locked D8 states merge "re-points all FK references through
    // the `patient_resolver` (no destructive UPDATE on satellite tables)" — identity resolution is
    // fresh-per-fetch via a live resolver, not a cached/pushed pointer this event would need to correct.
    declaredConsumers: [],
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
    eventName: "m5.patient.amendment_sla_due_soon",
    moduleOwner: "m5",
    description:
      "A pending §164.526 amendment request is within 10 days of its 60-day deadline (daily SLA scan, once per request).",
    payloadSchema: Type.Object({
      ...corePatient,
      amendmentId: Type.String(),
      slaDueAt: Type.String({ minLength: 1 }),
    }),
    // M36 pages the privacy / compliance audience (`36-messaging/outbox-consumers/amendment-sla-alerts.ts`).
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient.amendment_sla_overdue",
    moduleOwner: "m5",
    description:
      "A pending §164.526 amendment request passed its 60-day deadline undecided (daily SLA scan, once per request).",
    payloadSchema: Type.Object({
      ...corePatient,
      amendmentId: Type.String(),
      slaDueAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36"],
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
    // F-235 (#248) — the name is the spec's (§4.6); what it reports is decision B: M5 APPLIED an M22
    // DocLens demographics writeback (low-risk contact fields only) to the batch's already-resolved patient
    // — never a headless create. Emitted by `outbox-consumers/m22-extraction-writeback.ts` in the same
    // transaction as the chart rows; M22 stamps `extraction_provenance` from it.
    description:
      "M5 applied an M22 DocLens extraction commit (`m22.extraction.commit_requested`) to an existing patient's contact demographics; carries a per-field outcome (applied | already_present | skipped+reason), no values. M22 stamps `extraction_provenance.target_aggregate_id` for the fields the chart now holds.",
    payloadSchema: Type.Object({
      ...corePatient,
      extractionCommitId: Type.String({ minLength: 1 }),
      fieldOutcomes: Type.Array(
        Type.Object({
          fieldPath: Type.String({ minLength: 1 }),
          outcome: Type.Union([
            Type.Literal("applied"),
            Type.Literal("already_present"),
            Type.Literal("skipped"),
          ]),
          reason: Type.Optional(Type.String({ minLength: 1 })),
        }),
      ),
      appliedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m5.patient_allergy.draft_created_from_extraction",
    moduleOwner: "m5",
    // F-238 — M5 recorded a DocLens review's attested allergy lines as UNVERIFIED `patient_allergy` rows
    // (`outbox-consumers/m22-extraction-allergies.ts`, same transaction). M22's
    // `m22.extraction-clinical-writeback-backref` stamps `extraction_provenance` with each row id.
    description:
      "M5 recorded an M22 DocLens allergy commit (`m22.extraction.allergies_requested`) as unverified allergies on an existing patient; carries a per-line outcome (created | already_present | duplicate | skipped) with the `patient_allergy` id, no values.",
    payloadSchema: Type.Object({
      ...corePatient,
      extractionCommitId: Type.String({ minLength: 1 }),
      lineOutcomes: Type.Array(
        Type.Union([
          Type.Object({
            candidateId: Type.String({ minLength: 1 }),
            outcome: Type.Union([
              Type.Literal("created"),
              Type.Literal("already_present"),
              Type.Literal("duplicate"),
            ]),
            recordId: Type.String({ minLength: 1 }),
          }),
          Type.Object({
            candidateId: Type.String({ minLength: 1 }),
            outcome: Type.Literal("skipped"),
            reason: Type.String({ minLength: 1 }),
          }),
        ]),
      ),
      appliedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
];
