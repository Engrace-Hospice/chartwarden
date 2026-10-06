// apps/backend/src/modules/20-field-safety/events-by-m20.ts — Module 20's outbox-event contributions
// (§4.10). The `m20.safety.*` taxonomy under the `m20.` namespace (M01 D8 / M03 D9 / M04 D9).
// check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`), ownership
// (`moduleOwner: 'm20'`) and valid declared consumers; the composition root merges it into the platform
// catalog at boot (the M15/M23/M24/M25/M26/M27 events-by-mN precedent), and the dispatcher validates each
// `m20.*` publish against the TypeBox payloadSchema inside the SAME transaction as the mutation.
//
// WHY THIS FILE IS PART OF THE ROUTE TASK. `publishOutboxEvent` throws `unknown_event` for any name the
// boot catalog does not carry, and the throw rolls back the caller's transaction. So without this file
// every §4.1 mutation that declares an `{kind:'outbox'}` effect — which is nearly all of them — would fail
// at the moment of the write. The catalog is not documentation; it is the thing that makes the transition
// commit.
//
// THE SHAPES MIRROR the §4.10 payload interfaces frozen in `@wardenx/types` (packages/types/src/safety.ts,
// M20-T01), which are the contract M17/M22/M30/M33/M36 type-check against; this file is their runtime
// validator. The envelope carries `organizationId`, and every payload repeats it as `orgId` because
// `M20SafetyEventBase` does — a consumer holding the payload alone (M36's alert router) needs it.
//
// ── NO PAYLOAD CARRIES A COORDINATE, A NARRATIVE OR A PATIENT IDENTITY ─────────────────────────────
//
// §8.8.2's rule, expressed as schemas: ids, enum tokens, counts, booleans and instants only. The SOS raise
// carries `coordinatesCaptured: boolean` and NOT the coordinate; the terminus carries
// `psapJurisdictionId` and NOT the PSAP number; the incident events carry `category`/`severity` and NOT
// the narrative. There is no field here a §3.6-denylisted column could be assigned to, which is the
// compile-time half of the rule.
//
// ── THE TWO COMPOSITE IDEMPOTENCY KEYS ARE NOT REPEATED HERE ───────────────────────────────────────
//
// `M20_EVENT_IDEMPOTENCY_KEYS` (@wardenx/types) pins `check_in_escalated` to `[scheduleId, tier]` and
// `sos_terminus_reached` to `[sosAlertId, loopIteration]`, because each fires REPEATEDLY by design (one
// per D4 rung; one per terminus loop). The catalog's job is payload validity, so both discriminators —
// `tier` and `loopIteration` — are REQUIRED fields below: a payload that omitted them would be
// unkeyable, and a conforming consumer would collapse the very repetition the design requires.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const Id = Type.String({ minLength: 1 });
const IdOrNull = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const Iso = Type.String({ minLength: 1 });
const Str = Type.String();
const Bool = Type.Boolean();
const Count = Type.Integer({ minimum: 0 });

/** `M20SafetyEventBase` — every M20 payload carries these three (§4.10). */
const base = {
  orgId: Id,
  providerEntityId: Id,
  occurredAt: Iso,
};

export const M20_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── check-ins (§2.2.1, D2/D4) ─────────────────────────────────────────────────────────────────────
  {
    eventName: "m20.safety.check_in_recorded",
    moduleOwner: "m20",
    description:
      "A clinician posted a safety check-in (§2.2.1). Info severity, no fan-out: the supervisor board updates over M36's socket rooms rather than paging somebody every time a clinician says 'I'm OK'.",
    payloadSchema: Type.Object({
      ...base,
      checkInId: Id,
      scheduleId: IdOrNull,
      visitId: IdOrNull,
      clinicianMembershipId: Id,
      kind: Str,
      status: Str,
      coordinatesIncluded: Bool,
      isPartOfSosBracket: Bool,
    }),
    // F-133 (#248) — M17's day-view "last check-in" fact reads the SafetyDashboardProvider seam
    // PULL (M20 spec §1 "Consumed by 17"), not this push event; the spec's own §4.10 table carries
    // no "(M17 consumer ...)" annotation here (unlike `visit_cancellation_requested` and
    // `incident_report_requested`, which do), and this event's own description says "no fan-out."
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.check_in_overdue",
    moduleOwner: "m20",
    description:
      "A check-in obligation passed its fulfilment window (D4's gentle rung). Warn severity, to the subscribed supervisors.",
    payloadSchema: Type.Object({
      ...base,
      scheduleId: Id,
      clinicianMembershipId: Id,
      visitId: IdOrNull,
      kind: Str,
      expectedAt: Iso,
      minutesOverdue: Type.Number(),
    }),
    // GAP-061 — M36 binds a real push consumer (`outbox-consumers/field-safety-alerts.ts`), so it is DECLARED.
    declaredConsumers: ["m36"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.check_in_escalated",
    moduleOwner: "m20",
    description:
      "A D4 escalation rung fired for an unanswered check-in (§7.3). One event PER RUNG — `tier` is the discriminator, and `sos_equivalent` is the top rung that routes like an SOS.",
    payloadSchema: Type.Object({
      ...base,
      scheduleId: Id,
      clinicianMembershipId: Id,
      visitId: IdOrNull,
      minutesOverdue: Type.Number(),
      afterHours: Bool,
      tier: Str,
    }),
    // F-140 (#248) — m19 removed: M20's own locked D14 decision states the after-hours parallel-
    // recipient set is composed by M20 PULLING M19's `OnCallProvider.currentOnCallForProviderEntity`
    // seam at M36's `RecipientResolver`, explicitly "without M19 needing to know about safety alerts" —
    // the relationship is real but runs the opposite direction via a seam, never an M19 push subscription.
    // GAP-061 — see `check_in_overdue`: M36's `field-safety-alerts.ts` is the bound consumer.
    declaredConsumers: ["m36"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },

  // ── SOS (§2.2.2, D5/D6/D7) ────────────────────────────────────────────────────────────────────────
  {
    eventName: "m20.safety.sos_alert_raised",
    moduleOwner: "m20",
    description:
      "A clinician pressed the SOS button (§2.2.2 / M20-F10). Critical, system-locked, NON-IDEMPOTENT by design: every press is its own call for help.",
    payloadSchema: Type.Object({
      ...base,
      sosAlertId: Id,
      postedByMembershipId: Id,
      postedAt: Iso,
      lastKnownVisitId: IdOrNull,
      deviceAttested: Bool,
      coordinatesCaptured: Bool,
    }),
    // F-140 (#248) — m19 removed: same reasoning as `check_in_escalated` above — M20's own D14 decision
    // pulls M19's on-call seam rather than being pushed to by M19.
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.sos_alert_cancel_attempted_rejected",
    moduleOwner: "m20",
    description:
      "A cancel was pressed inside the D5 window and the biometric did not pass (§7.4's hostile-actor path). The alert PROCEEDS; this is the forensic record.",
    payloadSchema: Type.Object({
      ...base,
      sosAlertId: Id,
      attemptedAt: Iso,
      biometricResult: Str,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m4"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.sos_alert_acknowledged",
    moduleOwner: "m20",
    description:
      "A responder answered an SOS — the only exit from the escalation ladder. Also carries the raiser's own in-window cancel, discriminated by the row's cancel_status (§7.4).",
    payloadSchema: Type.Object({
      ...base,
      sosAlertId: Id,
      acknowledgedByMembershipId: Id,
      acknowledgedAt: Iso,
      tierAtAcknowledgment: Str,
      slaBreached: Bool,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.sos_alert_escalated",
    moduleOwner: "m20",
    description:
      "The SLA watchdog (or a delivery failure, or a supervisor) advanced the alert one tier (§2.2.2 / D7).",
    payloadSchema: Type.Object({
      ...base,
      sosAlertId: Id,
      fromTier: Str,
      toTier: Str,
      escalatedAt: Iso,
      reasonCode: Str,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.sos_terminus_reached",
    moduleOwner: "m20",
    description:
      "The life-safety chain reached `emergency_terminus` (M20-F05 / S13 / INT-031). Emitted on EVERY loop iteration — `loopIteration` is what lets a consumer tell the tenth page from the first without suppressing either.",
    payloadSchema: Type.Object({
      ...base,
      sosAlertId: Id,
      terminusReachedAt: Iso,
      loopIteration: Count,
      emergencyContactCallInitiated: Bool,
      psapJurisdictionId: IdOrNull,
      wardenxOpsPaged: Bool,
    }),
    // F-132 (#248) — m34 REMOVED: M34's own spec never names M20 anywhere ("Depends on"/"Consumed by"
    // enumerate 1,2,3,4,22,36 and 1,2,3,4,22,23,24,29,33,35 respectively — M20 is absent from both), and
    // M34 states plainly it "consumes no clinical predicates... M34's surface is platform-administrative
    // not patient-clinical." An unsupported guess, dropped, not a redundant-with-seam case.
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.sos_alert_resolved",
    moduleOwner: "m20",
    description: "A responder closed the SOS with an outcome and a narrative (§2.2.2).",
    payloadSchema: Type.Object({
      ...base,
      sosAlertId: Id,
      resolvedByMembershipId: Id,
      outcome: Str,
      resolvedAt: Iso,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.sos_anomaly_volume",
    moduleOwner: "m20",
    description:
      "More than SAFETY_SOS_ANOMALY_VOLUME_PER_HOUR presses from one clinician in an hour (§8.3). A FLAG to compliance, never a gate — the eleventh press escalates exactly like the first.",
    payloadSchema: Type.Object({
      ...base,
      clinicianMembershipId: Id,
      pressesInWindow: Count,
      windowHours: Count,
      detectedAt: Iso,
    }),
    declaredConsumers: [],
    seamConsumers: ["m4", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.device_attestation_anomaly",
    moduleOwner: "m20",
    description:
      "A safety write arrived from an unattested device (§8.3). The alert still fanned out; this is the forensics trail behind it.",
    payloadSchema: Type.Object({
      ...base,
      clinicianMembershipId: Id,
      deviceId: IdOrNull,
      sosAlertId: IdOrNull,
      checkInId: IdOrNull,
      detectedAt: Iso,
    }),
    // F-132 (#248) — m34 REMOVED: same reasoning as `m20.safety.sos_terminus_reached` above.
    declaredConsumers: [],
    seamConsumers: ["m4"],
    isOutboxOnly: true,
  },

  // ── incidents (§2.2.3, D9) ────────────────────────────────────────────────────────────────────────
  {
    eventName: "m20.safety.incident_reported",
    moduleOwner: "m20",
    description:
      "An incident DRAFT was opened (§2.2.3). Distinct from `incident_submitted`, which is the immutability entry point — nothing is filed yet.",
    payloadSchema: Type.Object({
      ...base,
      incidentId: Id,
      affectedClinicianMembershipId: Id,
      reportedByMembershipId: Id,
      category: Str,
      severity: Str,
      occurredAt: Iso,
      linkedSosAlertId: IdOrNull,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.incident_submitted",
    moduleOwner: "m20",
    description:
      "An incident was submitted for supervisor review (§2.2.3). Warn severity, to the supervisors plus the compliance officer.",
    payloadSchema: Type.Object({
      ...base,
      incidentId: Id,
      affectedClinicianMembershipId: Id,
      category: Str,
      severity: Str,
      occurredAt: Iso,
      oshaReportable: Bool,
      linkedSosAlertId: IdOrNull,
    }),
    // F-149 (#248) — m30 removed: M30's own §1.1 relationship inventory is a flat, explicit denial —
    // "Field safety. Module 20. No M30 consumption path — field-safety incidents flow through M30 as
    // `incident_report` rows with `kind='other_safety_event'`… M30 does not directly read M20 schemas"
    // (docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md:128) — confirmed against M30's own code
    // (zero M20 references anywhere in `apps/backend/src/modules/30-quality/`). Every one of M20's
    // three remaining `m30`-declared events shares this finding.
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.incident_closed_with_action",
    moduleOwner: "m20",
    description: "An incident closed WITH an action plan (§2.2.3).",
    payloadSchema: Type.Object({
      ...base,
      incidentId: Id,
      closedByMembershipId: Id,
      closedAt: Iso,
    }),
    // F-149 (#248) — m30 removed: see `incident_submitted` above.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.incident_report_requested",
    moduleOwner: "m20",
    description:
      "The incident's PDF render was requested. M22's renderer consumes it; M20 ships no PDF code (§4.10).",
    payloadSchema: Type.Object({
      ...base,
      incidentId: Id,
      /** The chart target, or null for a staff-safety incident with no patient (F-099). */
      patientId: Type.Union([Id, Type.Null()]),
      renderTargetKind: Type.Literal("pdf"),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.osha_reportable_incident_filed",
    moduleOwner: "m20",
    description:
      "A supervisor signed off an OSHA-equivalent classification (§7.6 / D9). `reportingWindowHours` is the state-specific clock the filing has to beat; the filing itself is manual or M29's.",
    payloadSchema: Type.Object({
      ...base,
      incidentId: Id,
      category: Str,
      severity: Str,
      signedOffByMembershipId: Id,
      signedOffAt: Iso,
      stateCode: Str,
      reportingWindowHours: Count,
    }),
    // F-141 (#248) — m29 dropped: M29's own locked "four-pillar scope" (D1: HL7 inbound/outbound,
    // NPPES, Xero/Gusto) never mentions OSHA or workers-comp anywhere; this event's own description
    // already hedges the filing as "manual or M29's" — an aspiration, not a decided M29 mechanism.
    // F-149 (#248) — m30 removed: see `incident_submitted` above.
    declaredConsumers: [],
    seamConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.workers_comp_claim_initiated",
    moduleOwner: "m20",
    description:
      "The workers-comp flag was set on an incident (§7.6). A downstream WC integration picks it up.",
    payloadSchema: Type.Object({
      ...base,
      incidentId: Id,
      initiatedByMembershipId: Id,
      initiatedAt: Iso,
    }),
    // F-141 (#248) — m29 dropped: same reasoning as `osha_reportable_incident_filed` above — no
    // support anywhere in M29's locked scope.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },

  // ── advisory geography + policy + coverage (§2.2.7, §2.2.4, §7.8) ─────────────────────────────────
  {
    eventName: "m20.safety.high_risk_area_entered",
    moduleOwner: "m20",
    description:
      "A clinician's position was evaluated inside an advisory polygon (D12). Advisory only — M20 blocks no visit.",
    payloadSchema: Type.Object({
      ...base,
      clinicianMembershipId: Id,
      areaId: Id,
      riskCategory: Str,
      enteredAt: Iso,
      visitId: IdOrNull,
    }),
    // F-215 (#248) — m17 DROPPED: M17's own spec has zero mentions of high-risk areas (the producer-side
    // claim in M20's "Consumed by" line is unsupported on the consumer side — F-101, the consumer's
    // decisive text wins), M20's own banner is a read-time render, and nothing ever publishes this event
    // (only the M36 alert builder exists). M36 stays via seam.
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.policy_changed",
    moduleOwner: "m20",
    description:
      "A new `safety_policy_version` took effect (§2.2.4). `thresholdDiffs` says which knobs moved and in which direction — §8.8.2's compliance read is 'why did they loosen it'.",
    payloadSchema: Type.Object({
      ...base,
      newVersionId: Id,
      changedByMembershipId: Id,
      changedAt: Iso,
      thresholdDiffs: Type.Array(Type.Object({ field: Str, direction: Str })),
    }),
    declaredConsumers: [],
    seamConsumers: ["m36", "m4"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.policy_violation_recorded",
    moduleOwner: "m20",
    description:
      "The policy said one thing and the system observed another (§8.2) — a suppression beyond D13, a cadence that never materialized, a coordinate read with no paired narrative.",
    payloadSchema: Type.Object({
      ...base,
      violationKind: Str,
      subjectMembershipId: IdOrNull,
      detectedAt: Iso,
      policyVersionId: Id,
    }),
    declaredConsumers: [],
    seamConsumers: ["m4", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.coverage_gap_detected",
    moduleOwner: "m20",
    description:
      "A field-eligible clinician has nobody subscribed to page for her (§7.8). Critical, system-locked: this is not a condition a tenant may switch off.",
    payloadSchema: Type.Object({
      ...base,
      clinicianMembershipId: Id,
      reason: Str,
      detectedAt: Iso,
    }),
    // F-132 (#248) — m34 REMOVED: same reasoning as `m20.safety.sos_terminus_reached` above.
    // GAP-061 — M36's `field-safety-alerts.ts` is the bound consumer (was a seam-only m36).
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m20.safety.visit_cancellation_requested",
    moduleOwner: "m20",
    description:
      "An SOS resolved with `outcome='visit_cancelled'` (§7.5). M20 never writes an M17 row — this event IS the request and M17's D3 handler decides.",
    payloadSchema: Type.Object({
      ...base,
      sosAlertId: Id,
      visitId: Id,
      requestedAt: Iso,
    }),
    declaredConsumers: ["m17"],
    isOutboxOnly: true,
  },
];
