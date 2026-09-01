// apps/backend/src/modules/23-billing-medicare/events-by-m23.ts — Module 23's outbox-event contributions
// (spec §4.10 Outbox Event Catalog). The full `m23.*` taxonomy keyed on M23's own resources, under the
// `m23.` namespace (M01 D8 outbox_event_catalog / M03 D9 / M04 D9). check-fitness-gaps.ts scans this file
// for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m23'), and valid declared consumers (real
// module ids). The composition root merges this into the platform event catalog at boot (the M27/M30/M33/M34
// events-by-mN precedent); the dispatcher validates each `m23.*` publish against the TypeBox `payloadSchema`
// inside the same transaction as the mutation (the D2 transactional-outbox posture).
//
// NO PHI / NO MBI in any payload (D13, §3.6, §8.7) — every payload is IDs + control numbers + aggregate
// facts only; the MBI is never persisted nor emitted, and `patientId` is an opaque row id (not a name/MBI).
// The cross-module fan-outs target M22 (PDF render handshake), M25 (remittance), M26 (cap projection),
// M27 (cost report), M28 (FHIR), M30 (HQRP), M33 (dashboards/AR), M34 (tenant wizard), M36 (alerts), M6
// (NOE/NOTR compliance-window close), M4 (surveyor-mode reflect), and M1 (system_status).
//
// COUNT RECONCILIATION: the §4.10 prose says "31 topics", but that figure is STALE — it predates the later
// `claim.adjudicated`, `claim.line_finalized`, and `abn.required` rows AND collapses the `m23.notr.*` family
// into a single "(mirror of NOE)" table row. This file ships the COMPLETE concrete contract: the NOTR family
// is expanded into its 7 real events (the §4.8 `m23.notr.submit` / `m23.notr.window-watch` queues + the §4.9
// `m23.notr.window_*` alerts require them), yielding 40 events (18 claim + 7 noe + 7 notr + 3 eligibility +
// 1 mac_credential + 2 mac_portal + 1 billing-render + 1 abn). Severity (§4.10 col 2) and alert routing
// (§4.9) are NOT part of the OutboxEventEntry shape — they live in `@wardenx/billing`'s alerts.ts.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const nullableId = Type.Union([id, Type.Null()]);
const nullableInstant = Type.Union([isoInstant, Type.Null()]);
const str = Type.String();
const cents = Type.Integer();
const int = Type.Integer();

export const M23_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── claim lifecycle (§2.2 / §4.10) ────────────────────────────────────────────────────────────────
  {
    eventName: "m23.claim.draft_created",
    moduleOwner: "m23",
    description:
      "A claim DRAFT was assembled from clinical artifacts (PE + patient + admission + TOB + service window).",
    payloadSchema: Type.Object({
      claimId: id,
      providerEntityId: id,
      patientId: id,
      admissionId: id,
      tob: str,
      serviceFrom: isoInstant,
      serviceTo: isoInstant,
    }),
    declaredConsumers: ["m23", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.validation_started",
    moduleOwner: "m23",
    description:
      "A claim entered VALIDATING; a validation_run was enqueued against the current claim state.",
    payloadSchema: Type.Object({ claimId: id, validationRunId: id, trigger: str }),
    declaredConsumers: ["m23", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.validation_failed",
    moduleOwner: "m23",
    description:
      "A validation run produced one or more failing rules; the failed rule keys are attached.",
    payloadSchema: Type.Object({
      claimId: id,
      validationRunId: id,
      failedRuleKeys: Type.Array(str),
    }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.ready_for_submission",
    moduleOwner: "m23",
    description:
      "Validation completed with no unresolved blocking failures; the claim transitioned VALIDATING → READY.",
    payloadSchema: Type.Object({ claimId: id, validationRunId: id }),
    declaredConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.submit_requested",
    moduleOwner: "m23",
    description:
      "The user clicked Submit (D2): the same-transaction outbox emit that drives the claim.submit worker.",
    payloadSchema: Type.Object({
      claimId: id,
      submissionId: id,
      claimControlNumber: str,
      attemptIndex: int,
    }),
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.submitted",
    moduleOwner: "m23",
    description:
      "The submission worker uploaded the 837I to the MAC portal; the claim transitioned READY → SUBMITTED.",
    payloadSchema: Type.Object({
      claimId: id,
      submissionId: id,
      claimControlNumber: str,
      macJurisdiction: str,
      submittedAt: isoInstant,
    }),
    declaredConsumers: ["m22", "m25", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.submission_failed",
    moduleOwner: "m23",
    description:
      "The submission worker reported a MAC-portal upload failure; the retry worker picks it up.",
    payloadSchema: Type.Object({ claimId: id, submissionId: id, attemptIndex: int, reason: str }),
    declaredConsumers: ["m23", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.submission_stalled",
    moduleOwner: "m23",
    description:
      "The retry worker exhausted its attempts (max 5); the stalled-submission alert is dispatched.",
    payloadSchema: Type.Object({ claimId: id, submissionId: id, attemptIndex: int, reason: str }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.acknowledged",
    moduleOwner: "m23",
    description:
      "The 277CA accepted the claim; ACK_PENDING → ACK_ACCEPTED with the payer claim control number.",
    payloadSchema: Type.Object({ claimId: id, acknowledgmentId: id, payerClaimControlNumber: str }),
    declaredConsumers: ["m22", "m25", "m26", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.acknowledgment_partial",
    moduleOwner: "m23",
    description:
      "The 277CA partially accepted the claim; ACK_PENDING → ACK_PARTIAL with per-line accept/reject sets.",
    payloadSchema: Type.Object({
      claimId: id,
      acknowledgmentId: id,
      acceptedLineNumbers: Type.Array(int),
      rejectedLineNumbers: Type.Array(int),
      rejectionCodes: Type.Array(str),
    }),
    declaredConsumers: ["m25", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.rejected",
    moduleOwner: "m23",
    description:
      "A 999 syntax fail or 277CA reject; the claim transitioned to ACK_REJECTED with the rejection stage + codes.",
    payloadSchema: Type.Object({
      claimId: id,
      acknowledgmentId: id,
      rejectionStage: str,
      rejectionCodes: Type.Array(str),
    }),
    declaredConsumers: ["m22", "m25", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.paid",
    moduleOwner: "m23",
    description:
      "M25 posted the 835 with full payment; ACK_ACCEPTED → PAID with the paid amount (cents).",
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
    description: "M25 posted a denial 835; ACK_ACCEPTED → DENIED with the denial codes.",
    payloadSchema: Type.Object({
      claimId: id,
      remittanceAdviceId: id,
      denialCodes: Type.Array(str),
    }),
    declaredConsumers: ["m25", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.adjudicated",
    moduleOwner: "m23",
    description:
      "The claim reached a terminal adjudication outcome (the single 'adjudication complete' signal for measure recompute).",
    payloadSchema: Type.Object({
      claimId: id,
      providerEntityId: id,
      outcome: Type.Union([
        Type.Literal("paid"),
        Type.Literal("partial_paid"),
        Type.Literal("denied"),
      ]),
      remittanceAdviceId: id,
      adjudicatedAt: isoInstant,
    }),
    declaredConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.line_finalized",
    moduleOwner: "m23",
    description:
      "A claim_line reached a final adjudicated state (per posted remittance line) — day-level accrual signal.",
    payloadSchema: Type.Object({
      claimId: id,
      claimLineId: id,
      revenueCode: str,
      serviceDate: isoInstant,
      days: int,
      finalizedAt: isoInstant,
    }),
    declaredConsumers: ["m26", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.replaced",
    moduleOwner: "m23",
    description:
      "A TOB 817 replacement was accepted at 277CA; the original claim transitioned ACK_ACCEPTED → REPLACED.",
    payloadSchema: Type.Object({ originalClaimId: id, replacementClaimId: id, reason: str }),
    declaredConsumers: ["m26", "m27", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.voided",
    moduleOwner: "m23",
    description:
      "A TOB 818 void was accepted at 277CA; the original claim transitioned ACK_ACCEPTED → VOIDED.",
    payloadSchema: Type.Object({ originalClaimId: id, voidClaimId: id, reason: str }),
    declaredConsumers: ["m26", "m27", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.claim.override_applied",
    moduleOwner: "m23",
    description:
      "A validation_override was inserted against a failing result (audit-prominent; surveyor-mode reflected).",
    payloadSchema: Type.Object({
      claimId: id,
      validationRunId: id,
      resultId: id,
      overrideId: id,
      ruleKey: str,
      overrideRoleApplied: str,
    }),
    declaredConsumers: ["m33", "m4"],
    isOutboxOnly: true,
  },
  // ── NOE lifecycle (§3.x / §4.10) ──────────────────────────────────────────────────────────────────
  {
    eventName: "m23.noe.draft_created",
    moduleOwner: "m23",
    description:
      "A NOE draft was created from m6.election.signed; the 5-day filing window target was computed.",
    payloadSchema: Type.Object({
      noeId: id,
      providerEntityId: id,
      admissionId: id,
      electionEffectiveDate: isoInstant,
      windowTargetAt: isoInstant,
    }),
    declaredConsumers: ["m23", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.submit_requested",
    moduleOwner: "m23",
    description:
      "A NOE became READY; the same-transaction outbox emit that drives the noe.submit worker.",
    payloadSchema: Type.Object({ noeId: id, submissionId: id, noeControlNumber: str }),
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.submitted",
    moduleOwner: "m23",
    description: "The noe.submit worker uploaded the NOE to the MAC portal; READY → SUBMITTED.",
    payloadSchema: Type.Object({ noeId: id, submissionId: id, submittedAt: isoInstant }),
    declaredConsumers: ["m22", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.accepted",
    moduleOwner: "m23",
    description:
      "The NOE was accepted; ACK_PENDING → ACK_ACCEPTED — closes the M6 NOE compliance window.",
    payloadSchema: Type.Object({ noeId: id, acknowledgmentId: id, payerNoeControlNumber: str }),
    declaredConsumers: ["m6", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.rejected",
    moduleOwner: "m23",
    description: "The NOE was rejected; the rejection codes are attached for remediation + alert.",
    payloadSchema: Type.Object({ noeId: id, rejectionCodes: Type.Array(str) }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.window_warning",
    moduleOwner: "m23",
    description:
      "The day-3 NOE-window watchdog tick fired (the 5-day CMS filing window is at risk).",
    payloadSchema: Type.Object({ noeId: id, admissionId: id, daysIntoWindow: int }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.noe.window_breached",
    moduleOwner: "m23",
    description: "The day-5+1 NOE-window watchdog tick fired (the CMS filing window was breached).",
    payloadSchema: Type.Object({ noeId: id, admissionId: id, breachedAt: isoInstant }),
    declaredConsumers: ["m36", "m33", "m30"],
    isOutboxOnly: true,
  },
  // ── NOTR lifecycle (§4.10 "mirror of NOE", expanded to the 7 concrete events) ──────────────────────
  {
    eventName: "m23.notr.draft_created",
    moduleOwner: "m23",
    description:
      "A NOTR draft was created from a discharge/revocation; the filing window target was computed.",
    payloadSchema: Type.Object({
      notrId: id,
      providerEntityId: id,
      admissionId: id,
      terminationEffectiveDate: isoInstant,
      windowTargetAt: isoInstant,
    }),
    declaredConsumers: ["m23", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.submit_requested",
    moduleOwner: "m23",
    description:
      "A NOTR became READY; the same-transaction outbox emit that drives the notr.submit worker.",
    payloadSchema: Type.Object({ notrId: id, submissionId: id, notrControlNumber: str }),
    declaredConsumers: ["m23"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.submitted",
    moduleOwner: "m23",
    description: "The notr.submit worker uploaded the NOTR to the MAC portal; READY → SUBMITTED.",
    payloadSchema: Type.Object({ notrId: id, submissionId: id, submittedAt: isoInstant }),
    declaredConsumers: ["m22", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.accepted",
    moduleOwner: "m23",
    description:
      "The NOTR was accepted; ACK_PENDING → ACK_ACCEPTED — closes the M6 NOTR compliance window.",
    payloadSchema: Type.Object({ notrId: id, acknowledgmentId: id, payerNotrControlNumber: str }),
    declaredConsumers: ["m6", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.rejected",
    moduleOwner: "m23",
    description: "The NOTR was rejected; the rejection codes are attached for remediation + alert.",
    payloadSchema: Type.Object({ notrId: id, rejectionCodes: Type.Array(str) }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.window_warning",
    moduleOwner: "m23",
    description: "The day-3 NOTR-window watchdog tick fired (the filing window is at risk).",
    payloadSchema: Type.Object({ notrId: id, admissionId: id, daysIntoWindow: int }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.notr.window_breached",
    moduleOwner: "m23",
    description: "The day-5+1 NOTR-window watchdog tick fired (the filing window was breached).",
    payloadSchema: Type.Object({ notrId: id, admissionId: id, breachedAt: isoInstant }),
    declaredConsumers: ["m36", "m33", "m30"],
    isOutboxOnly: true,
  },
  // ── eligibility (§4.8 / §4.10) ────────────────────────────────────────────────────────────────────
  {
    eventName: "m23.eligibility.refresh_requested",
    moduleOwner: "m23",
    description:
      "A HETS 270/271 refresh was requested (route 22 or stale-at-assembly); drives the eligibility.refresh worker.",
    payloadSchema: Type.Object({ patientId: id, asOfServiceDate: isoInstant }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.eligibility.checked",
    moduleOwner: "m23",
    description:
      "An eligibility_check row was inserted (MBI never persisted); the outcome + staleAt are attached.",
    payloadSchema: Type.Object({
      checkId: id,
      patientId: id,
      asOfServiceDate: isoInstant,
      outcome: str,
      checkedAt: isoInstant,
      staleAt: isoInstant,
    }),
    declaredConsumers: ["m23", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.eligibility.expired",
    moduleOwner: "m23",
    description:
      "The stale-watch cron marked an eligibility_check past its staleAt; the re-check prompt is raised.",
    payloadSchema: Type.Object({ patientId: id, lastCheckedAt: isoInstant }),
    declaredConsumers: ["m36", "m33"],
    isOutboxOnly: true,
  },
  // ── MAC credential + portal health (§4.8 / §4.10) ─────────────────────────────────────────────────
  {
    eventName: "m23.mac_credential.updated",
    moduleOwner: "m23",
    description:
      "A per-PE mac_submitter_credential was upserted (secrets never emitted); the version is bumped.",
    payloadSchema: Type.Object({ providerEntityId: id, macJurisdiction: str, version: int }),
    declaredConsumers: ["m34", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.mac_portal.unavailable",
    moduleOwner: "m23",
    description:
      "The health cron observed a MAC portal transition to down; a Tier-3 system-status event is raised.",
    payloadSchema: Type.Object({
      macJurisdiction: str,
      lastSeenUpAt: nullableInstant,
      downedAt: isoInstant,
    }),
    declaredConsumers: ["m36", "m33", "m1"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.mac_portal.recovered",
    moduleOwner: "m23",
    description:
      "The health cron observed a MAC portal transition back up; the system-status event clears.",
    payloadSchema: Type.Object({
      macJurisdiction: str,
      downedAt: isoInstant,
      recoveredAt: isoInstant,
    }),
    declaredConsumers: ["m36", "m33", "m1"],
    isOutboxOnly: true,
  },
  // ── M22 render handshake + ABN (§4.10) ────────────────────────────────────────────────────────────
  {
    eventName: "m23.billing.document_render_requested",
    moduleOwner: "m23",
    description:
      "An M22 PDF render+store was requested at NOE/NOTR submit or claim ack — typed per document kind.",
    payloadSchema: Type.Object({
      kind: Type.Union([
        Type.Literal("noe_confirmation_receipt"),
        Type.Literal("notr_confirmation_receipt"),
        Type.Literal("claim_acknowledgment_letter"),
        Type.Literal("denial_appeal_cover_letter"),
      ]),
      aggregateId: id,
      payload: Type.Record(Type.String(), Type.Unknown()),
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m23.abn.required",
    moduleOwner: "m23",
    description:
      "A coverage determination resolved a service line as non-covered; the CMS-R-131 ABN render is requested.",
    payloadSchema: Type.Object({
      abnId: id,
      patientId: id,
      organizationId: id,
      claimId: nullableId,
      serviceDescription: str,
      estimatedCost: cents,
      reasonNoncovered: str,
      requiredBy: isoInstant,
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
];
