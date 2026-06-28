// apps/backend/src/modules/25-remittance/events-by-m25.ts — Module 25's outbox-event contributions
// (spec §2.4 / §4.5). The `m25.*` taxonomy under the `m25.` namespace (M01 D8 / M03 D9 / M04 D9).
// check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m25'),
// and valid declared consumers (real module ids). The composition root merges this into the platform event
// catalog at boot (the M23/M27/M30/M33 events-by-mN precedent); the dispatcher validates each `m25.*`
// publish against the TypeBox `payloadSchema` inside the SAME transaction as the mutation (the D2
// transactional-outbox posture; the M25-F11 unmapped-CARC invariant emits in-transaction, never via trigger).
//
// NO PHI / NO MBI in any payload (D13, §3.6) — every payload is IDs + control numbers + codes + aggregate
// facts only; appeal-narrative / remark free-text / override justification are NEVER emitted. Cross-module
// fan-outs target M22 (PDF render handshake), M23 (claim state machine), M26 (cap accrual/reversal), M30
// (HQRP denial-rate), M33 (dashboards), and M36 (alerts).
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const str = Type.String();
const money = Type.Number();

export const M25_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── 835 ingestion (the M25-owned pull → parse → post pipeline, §1.1 / §2.2) ────────────────────────
  {
    eventName: "m25.edi.835_received",
    moduleOwner: "m25",
    description: "M25 pulled an 835/ERA from the clearinghouse (payerProgram discriminator); triggers parse.",
    payloadSchema: Type.Object({
      remittanceAdviceId: id,
      providerEntityId: id,
      payerId: id,
      payerProgram: Type.Union([
        Type.Literal("medicare"),
        Type.Literal("medicaid"),
        Type.Literal("commercial"),
      ]),
      minioObjectKey: str,
      fileSha256: str,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.remittance.parsed",
    moduleOwner: "m25",
    description: "The x12-worker parsed the 835 into line/service-line/adjustment/remark rows; enqueues posting.",
    payloadSchema: Type.Object({ remittanceAdviceId: id, lineCount: Type.Integer() }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.remittance.advice_posted",
    moduleOwner: "m25",
    description: "Posting completed for an advice (all lines matched/posted or flagged); cap + org-day rollup signal.",
    payloadSchema: Type.Object({
      remittanceAdviceId: id,
      providerEntityId: id,
      totalPaymentAmount: money,
      postedLineCount: Type.Integer(),
      unmatchedLineCount: Type.Integer(),
      postedAt: isoInstant,
    }),
    declaredConsumers: ["m26", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.remittance.manual_match_recorded",
    moduleOwner: "m25",
    description: "A billing specialist manually bound an unmatched line to a claim (audit-prominent).",
    payloadSchema: Type.Object({ remittanceLineId: id, claimId: id, matchedByMembershipId: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  // ── claim-state handshake back to M23 (§2.4 / architecture §11.A) ───────────────────────────────────
  {
    eventName: "m25.remittance.claim_paid",
    moduleOwner: "m25",
    description: "A line posted with full payment; advances the M23 claim ACK_ACCEPTED → PAID.",
    payloadSchema: Type.Object({ claimId: id, remittanceLineId: id, paidAmount: money, postedAt: isoInstant }),
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.remittance.claim_partial_paid",
    moduleOwner: "m25",
    description: "A line posted with partial payment; advances the M23 claim to PARTIAL_PAID.",
    payloadSchema: Type.Object({
      claimId: id,
      remittanceLineId: id,
      paidAmount: money,
      adjustedAmount: money,
      postedAt: isoInstant,
    }),
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.remittance.claim_denied",
    moduleOwner: "m25",
    description: "A line posted with zero payment + a denial-category CARC; advances the M23 claim to DENIED.",
    payloadSchema: Type.Object({ claimId: id, remittanceLineId: id, carcCodes: Type.Array(str), postedAt: isoInstant }),
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.remittance.claim_recouped",
    moduleOwner: "m25",
    description: "A CLP02=22 reversal posted (42 CFR §424.526); reverses the M23 claim PAID + the M26 cap accrual.",
    payloadSchema: Type.Object({ claimId: id, remittanceLineId: id, recoupedAmount: money, postedAt: isoInstant }),
    declaredConsumers: ["m23", "m26"],
    isOutboxOnly: true,
  },
  // ── denial worklist (§2.4) ──────────────────────────────────────────────────────────────────────────
  {
    eventName: "m25.denial.opened",
    moduleOwner: "m25",
    description: "A denial_case was seeded (from a CARC, a 277CA rejection, or an EVV-aggregator rejection).",
    payloadSchema: Type.Object({
      denialCaseId: id,
      providerEntityId: id,
      claimId: Type.Union([id, Type.Null()]),
      carcCode: str,
      category: str,
      source: str,
      dollarValue: money,
    }),
    declaredConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.denial.resolved_favorable_via_appeal",
    moduleOwner: "m25",
    description: "An appeal decided favorably; the underlying denial resolved and M23 may re-post the original line.",
    payloadSchema: Type.Object({ denialCaseId: id, appealCaseId: id, claimId: id, tier: str }),
    declaredConsumers: ["m23", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.taxonomy.unmapped_code_observed",
    moduleOwner: "m25",
    description: "The first occurrence of a CARC absent from M38's catalog (D13); proposes an M23 pre-submission rule.",
    payloadSchema: Type.Object({ carcCode: str, rarcCode: Type.Union([str, Type.Null()]), providerEntityId: id, denialCaseId: id }),
    declaredConsumers: ["m23", "m36"],
    isOutboxOnly: true,
  },
  // ── patient responsibility (Phase-2 forward seam, §2.4 / D8) ────────────────────────────────────────
  {
    eventName: "m25.patient_responsibility.recorded",
    moduleOwner: "m25",
    description: "A CAS group-PR adjustment recorded a patient_responsibility_ledger row (future Patient Statement).",
    payloadSchema: Type.Object({ ledgerId: id, patientId: id, prAmount: money }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  // ── appeal lifecycle + M22 render handshake (§1.1 / §2.4) ───────────────────────────────────────────
  {
    eventName: "m25.appeal.submitted",
    moduleOwner: "m25",
    description: "An appeal transitioned draft → submitted (step-up gated, within deadline); dashboard + packet signal.",
    payloadSchema: Type.Object({ appealCaseId: id, denialCaseId: id, tier: str, submittedAt: isoInstant }),
    declaredConsumers: ["m22", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.appeal_packet.render_requested",
    moduleOwner: "m25",
    description: "A typed appeal-packet render payload was emitted for M22 to render the tier-specific letter PDF.",
    payloadSchema: Type.Object({ appealCaseId: id, tier: str, payload: Type.Record(Type.String(), Type.Unknown()) }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.denial_resolution_letter.render_requested",
    moduleOwner: "m25",
    description: "A denial-resolution-letter render payload was emitted for M22 to render + persist the PDF.",
    payloadSchema: Type.Object({ denialCaseId: id, payload: Type.Record(Type.String(), Type.Unknown()) }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
];
