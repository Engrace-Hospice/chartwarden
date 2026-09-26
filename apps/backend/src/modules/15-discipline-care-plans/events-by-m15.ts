// apps/backend/src/modules/15-discipline-care-plans/events-by-m15.ts — Module 15's outbox-event
// contributions (spec §2.4). The `m15.*` taxonomy under the `m15.` namespace (M01 D8 / M03 D9 / M04 D9).
// check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m15')
// and valid declared consumers; the composition root merges it into the platform catalog at boot (the
// M23/M24/M25/M26/M27 events-by-mN precedent), and the dispatcher validates each `m15.*` publish against the
// TypeBox payloadSchema inside the SAME transaction as the mutation (transactional outbox).
//
// The shapes MIRROR the §2.4 payload interfaces frozen in `@wardenx/types` (packages/types/src/
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
import type { ModuleEventContribution } from "@wardenx/types";

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
    declaredConsumers: ["m14"],
    seamConsumers: ["m33"],
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
    declaredConsumers: ["m22", "m28", "m14", "m30"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m15.plan.discharged",
    moduleOwner: "m15",
    description:
      "The plan sealed its final discharge-kind version on m6.admission.discharged (§7.11); M16 seeds the bereavement plan from it.",
    payloadSchema: Type.Object({
      planId: Id,
      admissionId: Id,
      kind: Str,
      finalSnapshotVersionId: Id,
    }),
    declaredConsumers: ["m16", "m22", "m30"],
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
    declaredConsumers: ["m30"],
    seamConsumers: ["m33", "m36"],
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
    declaredConsumers: ["m30"],
    seamConsumers: ["m33"],
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
      "An append-only assessment amendment was signed (correction of record, M9 D9) — M22 re-renders, M30 re-measures.",
    payloadSchema: Type.Object({
      planId: Id,
      assessmentId: Id,
      kind: Str,
      amendedFields: Type.Array(Str),
      attestation: Str,
    }),
    declaredConsumers: ["m22", "m30"],
    isOutboxOnly: true,
  },
];
