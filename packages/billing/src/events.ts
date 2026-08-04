// @wardenx/billing — Module 23's outbox-event catalog (spec §4.10). The full `m23.*` taxonomy keyed on
// M23's own resources, under the `m23.` namespace (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). The
// backend `events-by-m23.ts` re-exports this; the composition root merges it into the platform event
// catalog at boot (the M27/M30/M33 events-by-mN precedent), and `check-fitness-gaps.ts` scans the backend
// file for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m23'), and valid declared consumers.
// The dispatcher validates each `m23.*` publish against the TypeBox `payloadSchema` inside the same
// transaction as the mutation (transactional outbox).
//
// M23 carries NO PHI and NEVER the MBI digit (D13 / §3.6 / §8.7) — every payload is IDs + aggregate
// billing facts only. The `m23.notr.*` family MIRRORS `m23.noe.*` (spec §4.10 lists NOE explicitly and
// references NOTR as a mirror); this catalog EXPANDS both for typed-payload completeness.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const isoDate = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);
const cents = Type.Integer();

export const M23_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── claim lifecycle (§3.4 / §4.10) ──────────────────────────────────────────────────────────────────
  {
    eventName: "m23.claim.draft_created",
    moduleOwner: "m23",
    description: "A claim was assembled from clinical artifacts into DRAFT.",
    payloadSchema: Type.Object({
      claimId: id,
      providerEntityId: id,
      patientId: id,
      admissionId: id,
      tob: id,
      serviceFrom: isoDate,
      serviceTo: isoDate,
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.validation_started",
    moduleOwner: "m23",
    description: "DRAFT → VALIDATING: a validation run was enqueued against the claim.",
    payloadSchema: Type.Object({ claimId: id, validationRunId: id, trigger: id }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.validation_failed",
    moduleOwner: "m23",
    description: "A validation run completed with blocking failures.",
    payloadSchema: Type.Object({
      claimId: id,
      validationRunId: id,
      failedRuleKeys: Type.Array(id),
    }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.ready_for_submission",
    moduleOwner: "m23",
    description: "VALIDATING → READY: no unresolved blocking failures remain.",
    payloadSchema: Type.Object({ claimId: id, validationRunId: id }),
    declaredConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.submit_requested",
    moduleOwner: "m23",
    description:
      "User clicked Submit; drives the m23.claim.submit worker (outbox-only MAC posture, D2).",
    payloadSchema: Type.Object({
      claimId: id,
      submissionId: id,
      claimControlNumber: id,
      attemptIndex: Type.Integer(),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.submitted",
    moduleOwner: "m23",
    description: "READY → SUBMITTED: the 837I was uploaded to the MAC portal.",
    payloadSchema: Type.Object({
      claimId: id,
      submissionId: id,
      claimControlNumber: id,
      macJurisdiction: id,
      submittedAt: isoInstant,
    }),
    declaredConsumers: ["m22", "m25", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.submission_failed",
    moduleOwner: "m23",
    description:
      "The submission worker reported a MAC portal failure (retry worker pickup signal).",
    payloadSchema: Type.Object({
      claimId: id,
      submissionId: id,
      attemptIndex: Type.Integer(),
      reason: id,
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.submission_stalled",
    moduleOwner: "m23",
    description: "The retry worker exhausted attempts (severity=critical alert).",
    payloadSchema: Type.Object({
      claimId: id,
      submissionId: id,
      attemptIndex: Type.Integer(),
      reason: id,
    }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.acknowledged",
    moduleOwner: "m23",
    description: "ACK_PENDING → ACK_ACCEPTED (277CA accepted).",
    payloadSchema: Type.Object({ claimId: id, acknowledgmentId: id, payerClaimControlNumber: id }),
    declaredConsumers: ["m22", "m25", "m26", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.acknowledgment_partial",
    moduleOwner: "m23",
    description: "ACK_PENDING → ACK_PARTIAL (some lines accepted, some rejected).",
    payloadSchema: Type.Object({
      claimId: id,
      acknowledgmentId: id,
      acceptedLineNumbers: Type.Array(Type.Integer()),
      rejectedLineNumbers: Type.Array(Type.Integer()),
      rejectionCodes: Type.Array(id),
    }),
    declaredConsumers: ["m25", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.rejected",
    moduleOwner: "m23",
    description: "999 syntax fail or 277CA reject (severity=critical).",
    payloadSchema: Type.Object({
      claimId: id,
      acknowledgmentId: id,
      rejectionStage: id,
      rejectionCodes: Type.Array(id),
    }),
    declaredConsumers: ["m22", "m25", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.paid",
    moduleOwner: "m23",
    description: "ACK_ACCEPTED → PAID (driven by m25.remittance.claim_paid).",
    payloadSchema: Type.Object({
      claimId: id,
      remittanceAdviceId: id,
      paidAmountCents: cents,
      paidAt: isoInstant,
    }),
    declaredConsumers: ["m26", "m27", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.denied",
    moduleOwner: "m23",
    description: "ACK_ACCEPTED → DENIED (driven by M25).",
    payloadSchema: Type.Object({
      claimId: id,
      remittanceAdviceId: id,
      denialCodes: Type.Array(id),
    }),
    declaredConsumers: ["m25", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.adjudicated",
    moduleOwner: "m23",
    description: "Claim reached a terminal adjudication outcome — the single recompute signal.",
    payloadSchema: Type.Object({
      claimId: id,
      providerEntityId: id,
      outcome: Type.Union([
        Type.Literal("paid"),
        Type.Literal("partial_paid"),
        Type.Literal("denied"),
      ]),
      remittanceAdviceId: nullableId,
      adjudicatedAt: isoInstant,
    }),
    declaredConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.line_finalized",
    moduleOwner: "m23",
    description: "A claim_line reached a final adjudicated state (per posted remittance line).",
    payloadSchema: Type.Object({
      claimId: id,
      claimLineId: id,
      revenueCode: id,
      serviceDate: isoDate,
      days: Type.Integer(),
      finalizedAt: isoInstant,
    }),
    declaredConsumers: ["m26", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.replaced",
    moduleOwner: "m23",
    description: "ACK_ACCEPTED → REPLACED (by TOB 817 acceptance).",
    payloadSchema: Type.Object({ originalClaimId: id, replacementClaimId: id, reason: id }),
    declaredConsumers: ["m26", "m27", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.voided",
    moduleOwner: "m23",
    description: "ACK_ACCEPTED → VOIDED (by TOB 818 acceptance).",
    payloadSchema: Type.Object({ originalClaimId: id, voidClaimId: id, reason: id }),
    declaredConsumers: ["m26", "m27", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.override_applied",
    moduleOwner: "m23",
    description: "A validation_override was inserted on a failed result.",
    payloadSchema: Type.Object({
      claimId: id,
      validationRunId: id,
      resultId: id,
      overrideId: id,
      ruleKey: id,
      overrideRoleApplied: id,
    }),
    declaredConsumers: ["m33", "m4"],
    isOutboxOnly: true,
  },
  // ── NOE fast-path (§4.10) ───────────────────────────────────────────────────────────────────────────
  {
    eventName: "m23.noe.draft_created",
    moduleOwner: "m23",
    description: "A NOE was created from m6.election.signed.",
    payloadSchema: Type.Object({
      noeId: id,
      providerEntityId: id,
      admissionId: id,
      electionEffectiveDate: isoDate,
      windowTargetAt: isoInstant,
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.submit_requested",
    moduleOwner: "m23",
    description: "NOE READY → submit worker pickup.",
    payloadSchema: Type.Object({ noeId: id, submissionId: id, noeControlNumber: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.submitted",
    moduleOwner: "m23",
    description: "NOE READY → SUBMITTED.",
    payloadSchema: Type.Object({ noeId: id, submissionId: id, submittedAt: isoInstant }),
    declaredConsumers: ["m22", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.accepted",
    moduleOwner: "m23",
    description: "NOE ACK_PENDING → ACK_ACCEPTED (closes the M6 NOE compliance window).",
    payloadSchema: Type.Object({ noeId: id, acknowledgmentId: id, payerNoeControlNumber: id }),
    declaredConsumers: ["m6", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.rejected",
    moduleOwner: "m23",
    description: "NOE → ACK_REJECTED (severity=critical).",
    payloadSchema: Type.Object({ noeId: id, rejectionCodes: Type.Array(id) }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.window_warning",
    moduleOwner: "m23",
    description: "Day-3 NOE-window watchdog tick (warn).",
    payloadSchema: Type.Object({ noeId: id, admissionId: id, daysIntoWindow: Type.Integer() }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.window_breached",
    moduleOwner: "m23",
    description: "Day-5+1 NOE-window watchdog tick (severity=critical; HQRP signal).",
    payloadSchema: Type.Object({ noeId: id, admissionId: id, breachedAt: isoInstant }),
    declaredConsumers: ["m36", "m33", "m30"],
    isOutboxOnly: true,
  },
  // ── NOTR fast-path (§4.10 — mirror of NOE) ────────────────────────────────────────────────────────────
  {
    eventName: "m23.notr.draft_created",
    moduleOwner: "m23",
    description:
      "A NOTR was created from m6.revocation.created / m6.discharge.* / m6.transfer.created.",
    payloadSchema: Type.Object({
      notrId: id,
      providerEntityId: id,
      admissionId: id,
      terminationEffectiveDate: isoDate,
      windowTargetAt: isoInstant,
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.submit_requested",
    moduleOwner: "m23",
    description: "NOTR READY → submit worker pickup.",
    payloadSchema: Type.Object({ notrId: id, submissionId: id, notrControlNumber: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.submitted",
    moduleOwner: "m23",
    description: "NOTR READY → SUBMITTED.",
    payloadSchema: Type.Object({ notrId: id, submissionId: id, submittedAt: isoInstant }),
    declaredConsumers: ["m22", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.accepted",
    moduleOwner: "m23",
    description: "NOTR ACK_PENDING → ACK_ACCEPTED.",
    payloadSchema: Type.Object({ notrId: id, acknowledgmentId: id, payerNotrControlNumber: id }),
    declaredConsumers: ["m6", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.rejected",
    moduleOwner: "m23",
    description: "NOTR → ACK_REJECTED (severity=critical).",
    payloadSchema: Type.Object({ notrId: id, rejectionCodes: Type.Array(id) }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.window_warning",
    moduleOwner: "m23",
    description: "Day-3 NOTR-window watchdog tick (warn).",
    payloadSchema: Type.Object({ notrId: id, admissionId: id, daysIntoWindow: Type.Integer() }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.window_breached",
    moduleOwner: "m23",
    description: "Day-5+1 NOTR-window watchdog tick (severity=critical).",
    payloadSchema: Type.Object({ notrId: id, admissionId: id, breachedAt: isoInstant }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  // ── eligibility (§4.10) ──────────────────────────────────────────────────────────────────────────────
  {
    eventName: "m23.eligibility.refresh_requested",
    moduleOwner: "m23",
    description:
      "Route 22 trigger / stale auto-trigger at claim assembly (HETS 270/271 worker pickup).",
    payloadSchema: Type.Object({ patientId: id, asOfServiceDate: isoDate }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.eligibility.checked",
    moduleOwner: "m23",
    description:
      "An eligibility_check row was inserted (the parsed outcome only — never the MBI, §3.6).",
    payloadSchema: Type.Object({
      checkId: id,
      patientId: id,
      asOfServiceDate: isoDate,
      outcome: id,
      checkedAt: isoInstant,
      staleAt: isoInstant,
    }),
    declaredConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.eligibility.expired",
    moduleOwner: "m23",
    description: "Stale-watch cron tick: the most-recent eligibility check aged out (warn).",
    payloadSchema: Type.Object({ patientId: id, lastCheckedAt: isoInstant }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  // ── MAC credential + portal health (§4.10) ───────────────────────────────────────────────────────────
  {
    eventName: "m23.mac_credential.updated",
    moduleOwner: "m23",
    description:
      "A mac_submitter_credential was upserted (secret redacted — only the version is signaled).",
    payloadSchema: Type.Object({
      providerEntityId: id,
      macJurisdiction: id,
      version: Type.Integer(),
    }),
    declaredConsumers: ["m34", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.mac_portal.unavailable",
    moduleOwner: "m23",
    description:
      "The health-cron transitioned a MAC portal to down (severity=critical; system_status).",
    payloadSchema: Type.Object({
      macJurisdiction: id,
      lastSeenUpAt: isoInstant,
      downedAt: isoInstant,
    }),
    declaredConsumers: ["m36", "m33", "m1"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.mac_portal.recovered",
    moduleOwner: "m23",
    description: "The health-cron transitioned a MAC portal back up.",
    payloadSchema: Type.Object({
      macJurisdiction: id,
      downedAt: isoInstant,
      recoveredAt: isoInstant,
    }),
    declaredConsumers: ["m36", "m33", "m1"],
    isOutboxOnly: true,
  },
  // ── document render + ABN (§4.10) ────────────────────────────────────────────────────────────────────
  {
    eventName: "m23.billing.document_render_requested",
    moduleOwner: "m23",
    description:
      "A NOE/NOTR receipt / claim-ack letter / denial-appeal cover letter render was requested.",
    payloadSchema: Type.Object({ kind: id, aggregateId: id, payload: Type.Unknown() }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.abn.required",
    moduleOwner: "m23",
    description:
      "A coverage determination resolved a service line as non-covered before the service is furnished.",
    payloadSchema: Type.Object({
      abnId: id,
      patientId: id,
      organizationId: id,
      claimId: nullableId,
      serviceDescription: id,
      estimatedCost: cents,
      reasonNoncovered: id,
      requiredBy: isoInstant,
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
];

/** The ordered `m23.*` event names this catalog declares (asserted in test; mirrored by events-by-m23.ts). */
export const M23_OUTBOX_EVENT_NAMES: readonly string[] = M23_OUTBOX_EVENTS.map((e) => e.eventName);
