import type { ModuleEventContribution } from "@chartwarden/types";
// apps/backend/src/modules/15-discipline-care-plans/events-by-m15.ts — Module 15's outbox-event
// contributions (spec §2.4). The `m15.*` taxonomy under the `m15.` namespace (M01 D8 / M03 D9 / M04 D9).
// check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m15')
// and valid declared consumers; the composition root merges it into the platform catalog at boot (the
// M23/M24/M25/M26/M27 events-by-mN precedent), and the dispatcher validates each `m15.*` publish against the
// TypeBox payloadSchema inside the SAME transaction as the mutation (transactional outbox).
//
// The shapes MIRROR the §2.4 payload interfaces frozen in `@chartwarden/types` (packages/types/src/
// discipline-plans.ts, M15-T01) — those are the contract M14/M16/M17/M22/M28/M30/M33/M36 type-check
// against; this file is their runtime validator. The envelope carries `organizationId`, so no payload
// repeats it.
//
// NO PHI in any payload: ids, enum tokens, counts, severities and instants only. The one structurally-open
// field is `m15.plan.version_signed.snapshot` — the SEALED §2.2.2 `state_snapshot` M22 renders the plan PDF
// from and M28 projects to FHIR. It is the plan document itself (the §4.1 phase-boundary render handshake,
// D12: M22 owns the render, M15 emits the typed payload), so it is declared `Type.Unknown()` and travels
// only to the modules named in `declaredConsumers`.
import { Type } from "@sinclair/typebox";

const Id = Type.String({ minLength: 1 });
const Iso = Type.String({ minLength: 1 });
const Str = Type.String();
const Count = Type.Integer({ minimum: 0 });

/** The D11 required-signer set sealed on a version at `in_review` (§3.5). */
const RequiredSignerSet = Type.Array(
  Type.Object({ role: Str, count: Type.Integer({ minimum: 1 }), isAcknowledgment: Type.Boolean() }),
);

export const M15_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m15.plan.bootstrapped",
    moduleOwner: "m15",
    description:
      "A discipline_care_plan stub was created — on m6.admission.activated for the three CoP kinds, or on the first volunteer assignment for volunteer_plan (§2.4).",
    payloadSchema: Type.Object({
      planId: Id,
      admissionId: Id,
      patientId: Id,
      kind: Str,
      requiredSignerSet: RequiredSignerSet,
    }),
    // F-176 (#248) — m14 moved to seamConsumers: M14's spec never names M15; M15's own spec makes the packet
    // integration a `DisciplinePlanReader` PULL.
    declaredConsumers: [],
    seamConsumers: ["m14", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.plan.version_signed",
    moduleOwner: "m15",
    description:
      "A discipline_care_plan_version satisfied its sealed D11 required-signer set. Carries the sealed state_snapshot — the M22 plan-PDF render handshake and the M28 FHIR CarePlan projection input (D12).",
    payloadSchema: Type.Object({
      planId: Id,
      versionId: Id,
      // F-166 (#248) — widened to carry the chart target: the M22 render-request `DocumentRequestPayload`
      // resolves `patientId` off the payload (top-level or the content blob), and `plan.patientId` was
      // already in scope at the one emit site — the F-099 "widen the payload, the fact is already in
      // hand" precedent, not a new cross-module read.
      patientId: Id,
      kind: Str,
      versionKind: Str,
      snapshot: Type.Unknown(),
      signers: Type.Array(
        Type.Object({
          membershipId: Id,
          role: Str,
          signedAt: Iso,
          isAcknowledgment: Type.Boolean(),
        }),
      ),
    }),
    // F-115 (#248) — m28 removed: never subscribes to anything (F-035; the CarePlan projection is read
    // live at request time).
    // F-176 (#248) — m14 moved to seamConsumers (same DisciplinePlanReader pull reasoning as `plan.bootstrapped`).
    // F-180 (#248) — m30 DROPPED: fresh re-check, not merely re-asserted. M30's own locked spec (§1.2,
    // binding) names exactly what it consumes from M15 — `DisciplineComplianceProvider`'s 4 measures
    // (supervisory/MSW/chaplain on-time, volunteer-gate) — none touches plan signing. No measure code, no
    // seam method, no spec text supports this declaration; the F-115 "genuine gap" framing was never itself
    // checked against M30's own text, only M15's producer-side guess.
    declaredConsumers: ["m22"],
    seamConsumers: ["m14", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.plan.discharged",
    moduleOwner: "m15",
    description:
      "The plan sealed its final discharge-kind version on m6.admission.discharged (§7.11).",
    payloadSchema: Type.Object({
      planId: Id,
      admissionId: Id,
      kind: Str,
      finalSnapshotVersionId: Id,
    }),
    // F-134 (#248) — `m16` removed: F-105 already established `m6.bereavement.eligible` is the ONLY
    // path a `bereavement_plan` row can come into existence (M16's own `consumers/index.ts`); this
    // description's "M16 seeds the bereavement plan from it" claim was never true, and M16's own
    // §4.5 outbox-subscriptions table never names this event.
    // F-144 (#248) — m22 REMOVED: M15's own Lock-status section makes the exhaustive, specific claim
    // "M22 discipline-plan PDF rendering subscribes to `m15.plan.version_signed` when M22 locks" — naming
    // only that sibling event, not this one. Discharge seals an existing already-rendered snapshot
    // version rather than producing a new artifact.
    // F-180 (#248) — m30 DROPPED: same reasoning as `m15.plan.version_signed` above — M30's own locked
    // spec §1.2 names only the 4 `DisciplineComplianceProvider` measures as its real M15 consumption; plan
    // discharge is not among them, no measure code or seam method reads it.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.aide_supervisory.completed",
    moduleOwner: "m15",
    description:
      "A 42 CFR 418.76(h) RN supervisory attestation landed; the plan's 14-day cadence clock re-armed (§7.1).",
    payloadSchema: Type.Object({
      planId: Id,
      supervisoryVisitId: Id,
      aideMembershipId: Id,
      supervisingRnMembershipId: Id,
      attestationMode: Str,
      performanceSatisfactory: Type.Boolean(),
      nextDueAt: Iso,
    }),
    // F-115 (#248) — m30 moved to seamConsumers: reads `DisciplineComplianceProvider.supervisoryOnTimeCounts`
    // (supervisory_visit_on_time, CoP 418.76(h)) on its nightly cadence, not by reacting to this event.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.aide_supervisory.overdue",
    moduleOwner: "m15",
    description: "The 6-hourly cadence cron found a breached 418.76(h) clock (§4.6).",
    payloadSchema: Type.Object({ planId: Id, hoursOverdue: Count, severity: Str }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.msw.assessment_initial_overdue",
    moduleOwner: "m15",
    description: "The D10 5-day MSW initial-assessment clock elapsed unsatisfied (§7.2).",
    payloadSchema: Type.Object({
      planId: Id,
      admissionId: Id,
      daysOverdue: Count,
      severity: Str,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.chaplain.assessment_initial_overdue",
    moduleOwner: "m15",
    description:
      "The D10 5-day chaplain clock elapsed with neither a signed initial assessment nor a recorded declination (§7.3).",
    payloadSchema: Type.Object({ planId: Id, admissionId: Id, daysOverdue: Count }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.volunteer.gate_expiring",
    moduleOwner: "m15",
    description: "The nightly gate watcher's 30/14/7/1-day expiry notice (§7.5).",
    payloadSchema: Type.Object({
      volunteerMembershipId: Id,
      gateKind: Str,
      validUntil: Iso,
      daysOut: Type.Integer(),
      severity: Str,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.volunteer.gate_expired",
    moduleOwner: "m15",
    description:
      "A 418.78 compliance gate flipped to `expired`; the volunteer's effective status is now inactive (§7.5).",
    payloadSchema: Type.Object({
      volunteerMembershipId: Id,
      gateKind: Str,
      expiredAt: Iso,
      openAssignmentsCount: Count,
    }),
    declaredConsumers: [],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.volunteer.assignment_inactivated",
    moduleOwner: "m15",
    description:
      "Open volunteer assignments were inactivated by a gate expiry, so M17 must drop the volunteer from the schedule (§7.5).",
    payloadSchema: Type.Object({
      volunteerMembershipId: Id,
      affectedPlanIds: Type.Array(Id),
      reason: Str,
    }),
    declaredConsumers: ["m17"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.volunteer.ratio_recomputed",
    moduleOwner: "m15",
    description:
      "The nightly 418.78(e) ledger refresh. Carries the volunteer-minute NUMERATOR only — the denominator is M27's patient-care hours, resolved at read time (M15-F04).",
    payloadSchema: Type.Object({
      providerEntityId: Id,
      fiscalYear: Type.Integer(),
      hoursMinutes: Count,
      status: Str,
    }),
    // F-215 (#248) — m30 DROPPED from `declaredConsumers` (F-180 had kept it, flagging exactly this
    // possibility): the event carries only the volunteer-minute NUMERATOR (M15-F04 — the denominator is
    // M27's patient-care hours, resolved at READ time), M30's own spec names only
    // `volunteer_compliance_gate_rate` from M15 (a seam pull on `DisciplineComplianceProvider`), and no
    // recompute trigger or measure consumes this push. M30's volunteer-hours ratio is a read-time seam
    // relationship, not outbox consumption. The separate, NON-outbox gap remains: nothing supplies M30's
    // denominator is now the signed hands-on visit minutes from M8's digests
    // (`consumers/patient-care-hours`), bound by the composition root.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.idg_decision.applied",
    moduleOwner: "m15",
    description:
      "The M14 IDG-decision consumer applied its mutations to a draft next version (§7.7); idempotent on idgDecisionId.",
    payloadSchema: Type.Object({
      planId: Id,
      versionId: Id,
      idgDecisionId: Id,
      mutationsApplied: Count,
    }),
    declaredConsumers: ["m14"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.discipline_assessment.amended",
    moduleOwner: "m15",
    description:
      "An append-only assessment amendment was signed (correction of record, M9 D9) — M30 re-measures.",
    payloadSchema: Type.Object({
      planId: Id,
      assessmentId: Id,
      kind: Str,
      amendedFields: Type.Array(Str),
      attestation: Str,
    }),
    // F-144 (#248) — m22 REMOVED: same Lock-status claim as `plan.discharged` above — M22 subscribes
    // only to `m15.plan.version_signed` for its discipline-plan PDF, not per-assessment amendments; no
    // "Done means" walkthrough anywhere describes M22 rendering an assessment amendment.
    // F-180 (#248) — m30 DROPPED: this description's own "M30 re-measures" is the producer's unverified
    // guess — M30's own locked spec §1.2 names only the 4 `DisciplineComplianceProvider` measures as its
    // real M15 consumption; assessment amendment is not among them (M30's only "amend" hit anywhere in its
    // spec is an unrelated QAPI-minutes amendment).
    declaredConsumers: [],
    isOutboxOnly: true,
  },
];
