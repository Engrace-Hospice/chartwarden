// apps/backend/src/modules/06-admission/events-by-m6.ts — Module 6's outbox-event contributions
// (M6-T10, spec §4.4). The full `m6.*` taxonomy keyed on M6's own tables, under the `m6.` namespace
// (M01 D8 / M03 D9). check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`),
// ownership (moduleOwner='m6'), and valid declared consumers (real module ids). The named cross-module
// consumers (M5/M7/M8/M11/M13/M14/M16/M22/M23/M26/M27/M28/M30/M33/M36/M37) subscribe when they land;
// M6 publishes the events now. Per §4.7 ("No webhook/Socket.IO") every M6 event is outbox-only.
//
// Provenance marker (§4.4): `m6.discharge.created`, `m6.discharge.death` and
// `m6.compliance.window.opened` are reused by the `AdmissionEventApplier` (M6-T11), which publishes
// them with `source='m29_proposal_accept'` — modelled as an OPTIONAL payload field so route-emitted and
// applier-emitted events share one schema and existing consumers keep working unmodified.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

/** The four CMS levels of care (mirrors `level_of_care`; §3.2). */
const levelOfCare = Type.Union([
  Type.Literal("routine_home_care"),
  Type.Literal("continuous_home_care"),
  Type.Literal("inpatient_respite_care"),
  Type.Literal("general_inpatient_care"),
]);

/** Compliance-window severity (`info` = D15 external signals). */
const windowSeverity = Type.Union([Type.Literal("warning"), Type.Literal("alert"), Type.Literal("info")]);

/** Optional provenance marker the AdmissionEventApplier stamps on applier-reused events (§4.4). */
const applierSource = Type.Optional(Type.Literal("m29_proposal_accept"));

export const M6_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── referral ──────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.referral.received",
    moduleOwner: "m6",
    description: "A referral was received (route 1) — M36 resolves recipients + dispatches (ADR-0024).",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      source: Type.String({ minLength: 1 }),
      receivedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.referral.accepted",
    moduleOwner: "m6",
    description: "A referral was accepted (route 6); seeds the draft admission + election form prep.",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36", "m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.referral.declined",
    moduleOwner: "m6",
    description: "The hospice declined the referral (route 7; clinical/geographic/capacity reasons — D16).",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.referral.withdrawn",
    moduleOwner: "m6",
    description: "The referring party/upstream system canceled the referral before a decision (D16; applier).",
    payloadSchema: Type.Object({
      referralId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      withdrawnVia: Type.String({ minLength: 1 }),
      originalReferralReceivedAt: Type.String({ minLength: 1 }),
      withdrawnAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── admission ─────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.admission.draft_created",
    moduleOwner: "m6",
    description: "The `admission.draft_from_referral` job created a draft admission + draft period 1.",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      referralId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.admission.activated",
    moduleOwner: "m6",
    description: "Admission activated (route 14) — the broad fan-out the whole system keys off.",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      activatedAt: Type.String({ minLength: 1 }),
      currentElectionPeriodId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [
      "m5", "m7", "m8", "m11", "m14", "m16", "m22", "m23",
      "m26", "m27", "m28", "m30", "m33", "m36", "m37",
    ],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.admission.on_hold",
    moduleOwner: "m6",
    description: "Admission placed on hold (route 12).",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      heldAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14", "m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.admission.resumed",
    moduleOwner: "m6",
    description: "Admission resumed from hold (route 13).",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      resumedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14", "m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.admission.discharged",
    moduleOwner: "m6",
    description: "Admission discharged (routes 36/37/38/39) — the broad close-out fan-out.",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      dischargeDate: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [
      "m14", "m16", "m22", "m23", "m26", "m27", "m28", "m30", "m33", "m36", "m37",
    ],
    isOutboxOnly: true,
  },
  // ── election ──────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.election.drafted",
    moduleOwner: "m6",
    description: "An election period was drafted (route 15/20).",
    payloadSchema: Type.Object({
      electionPeriodId: Type.String({ minLength: 1 }),
      sequence: Type.Integer({ minimum: 1 }),
      startDate: Type.String({ minLength: 1 }),
      endDate: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.election.signed",
    moduleOwner: "m6",
    description: "The election statement was signed (route 17).",
    payloadSchema: Type.Object({
      electionStatementId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      signedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22", "m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.election.period_started",
    moduleOwner: "m6",
    description: "An election period activated (admission.activate or auto-advance on recert).",
    payloadSchema: Type.Object({
      electionPeriodId: Type.String({ minLength: 1 }),
      sequence: Type.Integer({ minimum: 1 }),
      startDate: Type.String({ minLength: 1 }),
      endDate: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22", "m23", "m26", "m27"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.election.period_ended",
    moduleOwner: "m6",
    description: "An election period auto-ended at midnight on its endDate (trigger).",
    payloadSchema: Type.Object({
      electionPeriodId: Type.String({ minLength: 1 }),
      sequence: Type.Integer({ minimum: 1 }),
      endDate: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m23", "m26", "m27"],
    isOutboxOnly: true,
  },
  // ── certification (CTI) ─────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.cti.drafted",
    moduleOwner: "m6",
    description: "A certification of terminal illness was drafted (route 22).",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      isRecert: Type.Boolean(),
    }),
    declaredConsumers: ["m14"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.signed",
    moduleOwner: "m6",
    description: "A CTI was fully signed (route 24, or 25 when both signatures are required).",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      signedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22", "m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.late_flagged",
    moduleOwner: "m6",
    description: "A CTI was flagged late (route 27); carries the written-cert deadline.",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      writtenCertDeadlineAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.cti.voided",
    moduleOwner: "m6",
    description: "A CTI was voided (route 26).",
    payloadSchema: Type.Object({
      ctiId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14"],
    isOutboxOnly: true,
  },
  // ── face-to-face ────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.f2f.scheduled",
    moduleOwner: "m6",
    description: "A face-to-face encounter was scheduled (route 28).",
    payloadSchema: Type.Object({
      f2fId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      scheduledDate: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.f2f.attested",
    moduleOwner: "m6",
    description: "A face-to-face encounter was attested (route 31); may back-ref an encounter.",
    payloadSchema: Type.Object({
      f2fId: Type.String({ minLength: 1 }),
      electionPeriodId: Type.String({ minLength: 1 }),
      attestedAt: Type.String({ minLength: 1 }),
      encounterId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    declaredConsumers: ["m22", "m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.f2f.window_overridden",
    moduleOwner: "m6",
    description: "The F2F window was overridden by a compliance officer (route 32).",
    payloadSchema: Type.Object({
      f2fId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14", "m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.f2f.window_missed",
    moduleOwner: "m6",
    description: "The CMS F2F window closed without an attestation (scheduled job trigger).",
    payloadSchema: Type.Object({
      electionPeriodId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m14", "m30"],
    isOutboxOnly: true,
  },
  // ── level of care ───────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.loc.changed",
    moduleOwner: "m6",
    description: "The level of care changed (route 33); opens a new level-of-care period.",
    payloadSchema: Type.Object({
      levelOfCarePeriodId: Type.String({ minLength: 1 }),
      newLevel: levelOfCare,
      effectiveStart: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22", "m23", "m26", "m27", "m30"],
    isOutboxOnly: true,
  },
  // ── revocation / transfer ───────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.revocation.created",
    moduleOwner: "m6",
    description: "The beneficiary revoked the hospice election (route 36).",
    payloadSchema: Type.Object({
      revocationEventId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      revocationDate: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22", "m23", "m26"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.transfer.created",
    moduleOwner: "m6",
    description: "A hospice transfer (in/out) was recorded (routes 37/38).",
    payloadSchema: Type.Object({
      transferEventId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      direction: Type.Union([Type.Literal("in"), Type.Literal("out")]),
      otherHospiceCcn: Type.Optional(Type.String({ minLength: 1 })),
    }),
    declaredConsumers: ["m13", "m22", "m23", "m26"],
    isOutboxOnly: true,
  },
  // ── discharge ───────────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.discharge.created",
    moduleOwner: "m6",
    description: "A discharge was recorded (route 39; also recordExternalDeath via the applier).",
    payloadSchema: Type.Object({
      dischargeEventId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      dischargeDate: Type.String({ minLength: 1 }),
      requiresMedicalDirectorCosign: Type.Boolean(),
      source: applierSource,
    }),
    declaredConsumers: ["m14", "m22", "m23", "m26"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.discharge.death",
    moduleOwner: "m6",
    description: "Discharge reason was death (route 39 / recordExternalDeath) — seeds bereavement (D6).",
    payloadSchema: Type.Object({
      dischargeEventId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      dischargeDate: Type.String({ minLength: 1 }),
      source: applierSource,
    }),
    declaredConsumers: ["m16"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.discharge.cosigned",
    moduleOwner: "m6",
    description: "A for-cause discharge was cosigned by the medical director (route 40).",
    payloadSchema: Type.Object({
      dischargeEventId: Type.String({ minLength: 1 }),
      medicalDirectorCosignedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  // ── notice of rights ────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.nor.acknowledged",
    moduleOwner: "m6",
    description: "The Notice of Rights was acknowledged (route 41).",
    payloadSchema: Type.Object({
      norAcknowledgmentId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      acknowledgedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m22", "m23"],
    isOutboxOnly: true,
  },
  // ── compliance windows ──────────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.compliance.window.opened",
    moduleOwner: "m6",
    description: "A compliance window opened (trigger/job/applier); `severity='info'` = D15 external signal.",
    payloadSchema: Type.Object({
      complianceWindowId: Type.String({ minLength: 1 }),
      admissionId: Type.String({ minLength: 1 }),
      windowType: Type.String({ minLength: 1 }),
      dueAt: Type.String({ minLength: 1 }),
      severity: windowSeverity,
      source: applierSource,
    }),
    declaredConsumers: ["m14", "m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.compliance.window.closed",
    moduleOwner: "m6",
    description: "A compliance window closed (trigger); carries how it was closed.",
    payloadSchema: Type.Object({
      complianceWindowId: Type.String({ minLength: 1 }),
      closedAt: Type.String({ minLength: 1 }),
      closedVia: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.compliance.window.overdue",
    moduleOwner: "m6",
    description: "The `admission.window_alert` job moved an overdue window to alert severity.",
    payloadSchema: Type.Object({
      complianceWindowId: Type.String({ minLength: 1 }),
      severity: Type.Literal("alert"),
    }),
    declaredConsumers: ["m14", "m30"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.compliance.window.overridden",
    moduleOwner: "m6",
    description: "A compliance window was overridden by a compliance officer (route 46).",
    payloadSchema: Type.Object({
      complianceWindowId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m30"],
    isOutboxOnly: true,
  },
  // ── bereavement / applier ───────────────────────────────────────────────────────────────────────
  {
    eventName: "m6.bereavement.eligible",
    moduleOwner: "m6",
    description: "Post-rule check on `m6.discharge.death` cleared bereavement onboarding (W-DC-01).",
    payloadSchema: Type.Object({
      admissionId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      eligibleAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m16"],
    isOutboxOnly: true,
  },
  {
    eventName: "m6.applier.refused",
    moduleOwner: "m6",
    description: "The AdmissionEventApplier refused an M29 proposal on a contract violation (D13).",
    payloadSchema: Type.Object({
      proposalId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1 }),
      refusedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m30"],
    isOutboxOnly: true,
  },
];
