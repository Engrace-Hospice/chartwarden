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
// Decimal STRING, never a float — matches every `numeric(12,2)` column these payloads carry (and the
// identical convention already used for the same fields on the HTTP read side, m25-typebox.ts) so a
// future producer can pass the Drizzle `numeric` row value straight through (PARAM-003).
const money = Type.String({ description: "Decimal string — never a float" });

export const M25_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── 835 ingestion (the M25-owned pull → parse → post pipeline, §1.1 / §2.2) ────────────────────────
  {
    eventName: "m25.edi.835_received",
    moduleOwner: "m25",
    description:
      "M25 pulled an 835/ERA from the clearinghouse (payerProgram discriminator); triggers parse.",
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
    // F-020 (#49) — NOT record-only: `m25.parse-and-post` (outbox-consumers/live-binding.ts) binds
    // this event live and drives the parse + transactional-post + denial-seed half of the pipeline.
    // M25 is its own consumer here (the self-pull posture the file header describes — no other module
    // produces an 835 receipt). Catalogued `[]`, the dispatcher would have marked every 835 dispatched
    // WITHOUT delivering it, so it fails boot instead; either way nothing ever parsed an 835.
    declaredConsumers: ["m25"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.remittance.parsed",
    moduleOwner: "m25",
    description:
      "The x12-worker parsed the 835 into line/service-line/adjustment/remark rows; enqueues posting.",
    payloadSchema: Type.Object({ remittanceAdviceId: id, lineCount: Type.Integer() }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.remittance.advice_posted",
    moduleOwner: "m25",
    description:
      "Posting completed for an advice (all lines matched/posted or flagged); cap + org-day rollup signal.",
    payloadSchema: Type.Object({
      remittanceAdviceId: id,
      providerEntityId: id,
      totalPaymentAmount: money,
      postedLineCount: Type.Integer(),
      unmatchedLineCount: Type.Integer(),
      postedAt: isoInstant,
    }),
    declaredConsumers: ["m26"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.remittance.manual_match_recorded",
    moduleOwner: "m25",
    description:
      "A billing specialist manually bound an unmatched line to a claim (audit-prominent).",
    payloadSchema: Type.Object({ remittanceLineId: id, claimId: id, matchedByMembershipId: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  // ── claim-state handshake back to M23 (§2.4 / architecture §11.A) ───────────────────────────────────
  {
    eventName: "m25.remittance.claim_paid",
    moduleOwner: "m25",
    description: "A line posted with full payment; advances the M23 claim ACK_ACCEPTED → PAID.",
    payloadSchema: Type.Object({
      claimId: id,
      remittanceLineId: id,
      remittanceAdviceId: id,
      paidAmount: money,
      postedAt: isoInstant,
    }),
    // F-140 (#248) — m24 ADDED: M24's own authoritative `M24_SUBSCRIPTION_MAP` names this event
    // (`mark-claim-paid`) with a real handler (`handleClaimPaid`) — the same remittance-posted signal
    // both the Medicare (M23) and Medicaid (M24) claim lifecycles advance on. Reverses a stale exception
    // (`would-defer-a-bound-event`) that assumed adding a second declared consumer would interrupt M23's
    // live delivery — `buildOutboxRoutingPlan` delivers to every BOUND consumer regardless of what else
    // is declared (verified directly against `outbox-dispatcher.ts`, the F-139/m31 precedent).
    declaredConsumers: ["m23", "m24"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.remittance.claim_partial_paid",
    moduleOwner: "m25",
    description: "A line posted with partial payment; advances the M23 claim to PARTIAL_PAID.",
    payloadSchema: Type.Object({
      claimId: id,
      remittanceLineId: id,
      remittanceAdviceId: id,
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
    description:
      "A line posted with zero payment + a denial-category CARC; advances the M23 claim to DENIED.",
    payloadSchema: Type.Object({
      claimId: id,
      remittanceLineId: id,
      remittanceAdviceId: id,
      carcCodes: Type.Array(str),
      postedAt: isoInstant,
    }),
    // F-140 (#248) — m24 ADDED: same reasoning as `.claim_paid` above (`mark-claim-denied` /
    // `handleClaimDenied`).
    declaredConsumers: ["m23", "m24"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.remittance.claim_recouped",
    moduleOwner: "m25",
    description:
      "A CLP02=22 reversal posted (42 CFR §424.526); reverses the M23 claim PAID + the M26 cap accrual.",
    payloadSchema: Type.Object({
      claimId: id,
      remittanceLineId: id,
      remittanceAdviceId: id,
      recoupedAmount: money,
      postedAt: isoInstant,
    }),
    declaredConsumers: ["m23", "m26"],
    isOutboxOnly: true,
  },
  // ── denial worklist (§2.4) ──────────────────────────────────────────────────────────────────────────
  {
    eventName: "m25.denial.opened",
    moduleOwner: "m25",
    description:
      "A denial_case was seeded (from a CARC, a 277CA rejection, or an EVV-aggregator rejection).",
    payloadSchema: Type.Object({
      denialCaseId: id,
      providerEntityId: id,
      claimId: Type.Union([id, Type.Null()]),
      carcCode: str,
      category: str,
      source: str,
      dollarValue: money,
    }),
    declaredConsumers: ["m30"],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.denial.resolved_favorable_via_appeal",
    moduleOwner: "m25",
    description:
      "An appeal decided favorably; the underlying denial resolved and M23 may re-post the original line.",
    payloadSchema: Type.Object({ denialCaseId: id, appealCaseId: id, claimId: id, tier: str }),
    // F-136 (#248) — m23 REMOVED: M23's own claim state machine (§2.2) is explicit that the PAID
    // transition on a favorable appeal is driven by "M25 appeal succeeds + 835 RE-POSTED with payment" —
    // the re-post is `m25.remittance.claim_paid` (already bound), which carries the actual amount. This
    // event carries no payment fact of its own, so it is redundant with the transition M23 already reads.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.taxonomy.unmapped_code_observed",
    moduleOwner: "m25",
    description:
      "The first occurrence of a CARC absent from M38's catalog (D13); proposes an M23 pre-submission rule.",
    payloadSchema: Type.Object({
      carcCode: str,
      rarcCode: Type.Union([str, Type.Null()]),
      providerEntityId: id,
      denialCaseId: id,
    }),
    declaredConsumers: ["m23"],
    seamConsumers: ["m36"],
    isOutboxOnly: true,
  },
  // ── patient responsibility (Phase-2 forward seam, §2.4 / D8) ────────────────────────────────────────
  {
    eventName: "m25.patient_responsibility.recorded",
    moduleOwner: "m25",
    description:
      "A CAS group-PR adjustment recorded a patient_responsibility_ledger row (future Patient Statement).",
    payloadSchema: Type.Object({ ledgerId: id, patientId: id, prAmount: money }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  // ── appeal lifecycle + M22 render handshake (§1.1 / §2.4) ───────────────────────────────────────────
  {
    eventName: "m25.appeal.submitted",
    moduleOwner: "m25",
    description:
      "An appeal transitioned draft → submitted (step-up gated, within deadline); dashboard + packet signal.",
    payloadSchema: Type.Object({
      appealCaseId: id,
      denialCaseId: id,
      tier: str,
      submittedAt: isoInstant,
    }),
    // F-144 (#248) — m22 REMOVED: redundant sibling — the write service co-emits
    // `m25.appeal_packet.render_requested` in the SAME transition, already M22's real, LIVE-BOUND
    // render trigger (`M22_DOCUMENT_REQUEST_EVENTS`).
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.appeal_packet.render_requested",
    moduleOwner: "m25",
    description:
      "A typed appeal-packet render payload was emitted for M22 to render the tier-specific letter PDF.",
    payloadSchema: Type.Object({
      appealCaseId: id,
      tier: str,
      payload: Type.Record(Type.String(), Type.Unknown()),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m25.denial_resolution_letter.render_requested",
    moduleOwner: "m25",
    description:
      "A denial-resolution-letter render payload was emitted for M22 to render + persist the PDF.",
    payloadSchema: Type.Object({
      denialCaseId: id,
      payload: Type.Record(Type.String(), Type.Unknown()),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
];
