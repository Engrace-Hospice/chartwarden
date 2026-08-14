// apps/backend/src/modules/29-external-interfaces/events-by-m29.ts — M29's transactional-outbox
// event contribution (task-11 follow-up closing the TASK-006 gap: the accept/reject decision cores
// have produced these event envelopes since M29-T04, but nothing registered them in the boot
// catalog and the Drizzle store discarded them — so the M5/M6 accept consumers, deferred since
// Waves C/D, had nothing to consume). Folded into `buildBootOutboxCatalog` at the composition root;
// the Drizzle store publishes each within the deciding mutation's own tx.
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

/** Shared core — every proposal-decision event names the proposal + org (decision.ts payloads). */
const coreProposal = {
  proposalId: Type.String({ minLength: 1 }),
  organizationId: Type.String({ minLength: 1 }),
  sourceMessageId: Type.String({ minLength: 1 }),
  ownerModule: Type.Union([Type.Literal("m5"), Type.Literal("m6")]),
  decidedByMembershipId: Type.String({ minLength: 1 }),
  decidedAt: Type.String({ minLength: 1 }),
};

export const M29_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m29.hl7_inbound_proposal.accepted",
    moduleOwner: "m29",
    description:
      "A reviewer accepted an HL7 inbound proposal — the owner module (M5 demographics / M6 admission events) applies it via its outbox consumer (§4.10).",
    payloadSchema: Type.Object({
      ...coreProposal,
      resourceKind: Type.String({ minLength: 1 }),
      decisionRationale: Type.Union([Type.String(), Type.Null()]),
      matchedPatientId: Type.Union([Type.String(), Type.Null()]),
      acceptedAggregateId: Type.Union([Type.String(), Type.Null()]),
      appliedFields: Type.Union([Type.Array(Type.String()), Type.Null()]),
      // The parsed PID/event candidate — shape is owner-module-specific; the consumers' own
      // decision cores validate it (the catalog validates the envelope, not the clinical payload).
      proposedPatientCandidate: Type.Unknown(),
    }),
    declaredConsumers: ["m5", "m6"],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.hl7_inbound_proposal.rejected",
    moduleOwner: "m29",
    description:
      "A reviewer rejected an HL7 inbound proposal (≥40-char rationale, W-XI-04) — a durable record; no consumer applies anything.",
    payloadSchema: Type.Object({
      ...coreProposal,
      decisionRationale: Type.String({ minLength: 1 }), // rejects REQUIRE the ≥40-char rationale
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §4.2 / §4.10 unmatched-lab review decisions (GAP-044) ─────────────────────────────────────────
  // Both are record-only. The spec's §4.10 table lists M4 (and M11 for the bind) as consumers, but M4 is
  // the AUDIT module — its record is the write-audit trigger on the row itself, not an outbox
  // subscription — and M11's `order_record.fulfillment_status` flip keys on `m29.lab_observation
  // .attached`/`.received`, which a manual bind of an UNMATCHED result does not produce: an unmatched lab
  // has no OBR-2 placer, therefore no M11 order to fulfil. Declaring a consumer nobody binds would leave
  // every decision permanently `pending`; the row IS the durable record here.
  {
    eventName: "m29.lab_observation.manually_matched",
    moduleOwner: "m29",
    description:
      "A reviewer bound an unmatched lab result to a patient (§4.2) — the deferred lab_observation parent was materialized under the reserved id and the inbound link flipped to match_method='manual'.",
    payloadSchema: Type.Object({
      observationId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      patientId: Type.String({ minLength: 1 }),
      sourceMessageId: Type.String({ minLength: 1 }),
      loincCode: Type.String(),
      abnormalSummary: Type.String({ minLength: 1 }),
      decidedByMembershipId: Type.String({ minLength: 1 }),
      decidedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.lab_observation.discarded",
    moduleOwner: "m29",
    description:
      "A reviewer discarded an unmatched lab result (§4.2/§5.2.4, reason ≥10 chars) — the link row and its OBX values are retained per §8 (180 days) but stop surfacing in the queue. No lab_observation was ever created.",
    payloadSchema: Type.Object({
      observationId: Type.String({ minLength: 1 }),
      organizationId: Type.String({ minLength: 1 }),
      sourceMessageId: Type.String({ minLength: 1 }),
      decidedByMembershipId: Type.String({ minLength: 1 }),
      decidedAt: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 10 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },

  // ── §4.7 / §4.10 NPPES platform sync (GAP-045) ────────────────────────────────────────────────────
  // These five are PLATFORM-WIDE: every row publishes with `organization_id IS NULL` (one public CMS
  // directory, no tenant it belongs to). `provider_synced` / `provider_deactivated` declare `m40` because
  // M40 owns the canonical `external_physician` these keep current. Both appliers are LIVE as of GAP-099
  // (`40-mdm/outbox-consumers/m29-nppes-consumers.ts`, registered on the dispatcher's platform binding
  // list) — before that they could not be reached at all, because `pollPlatform()` had no way to deliver
  // an org-less row and M40's canonical had no write path. The three `sync_run.*` lifecycle events are
  // record-only: the row IS the operational record, and M33's dashboard reads `nppes_sync_run` directly
  // rather than subscribing.
  {
    eventName: "m29.nppes.provider_synced",
    moduleOwner: "m29",
    description:
      "A cached NPPES provider row was inserted or updated by the platform sync — M40 applies the §4.7.1 minimum-update to its canonical external_physician from the snapshot carried ON the event (ADR-0011 D1: M40 never reads M29's table).",
    payloadSchema: Type.Object({
      npi: Type.String({ minLength: 10, maxLength: 10 }),
      action: Type.Union([Type.Literal("inserted"), Type.Literal("updated")]),
      changedFields: Type.Array(Type.String()),
      syncedAt: Type.String({ minLength: 1 }),
      syncRunId: Type.String({ minLength: 1 }),
      provider: Type.Object({
        firstName: Type.String(),
        lastName: Type.String(),
        credentials: Type.Union([Type.String(), Type.Null()]),
        specialtyTaxonomy: Type.Union([Type.String(), Type.Null()]),
      }),
    }),
    declaredConsumers: ["m40"],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.nppes.provider_deactivated",
    moduleOwner: "m29",
    description:
      "NPPES flipped a provider active→deactivated (death, license revocation) — M40 deactivates the canonical and alerts every tenant whose overlay marked the provider preferred or attached to an active patient (§4.7.2).",
    payloadSchema: Type.Object({
      npi: Type.String({ minLength: 10, maxLength: 10 }),
      deactivationDate: Type.String({ minLength: 1 }),
      deactivationReason: Type.String({ minLength: 1 }),
      detectedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: ["m40"],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.nppes.sync_run.started",
    moduleOwner: "m29",
    description:
      "The platform NPPES sync opened a run (§4.10). Record-only — the durable operational trail beside the `nppes_sync_run` row it opened.",
    payloadSchema: Type.Object({
      syncRunId: Type.String({ minLength: 1 }),
      kind: Type.String({ minLength: 1 }),
      triggeredBy: Type.String({ minLength: 1 }),
      startedAt: Type.String({ minLength: 1 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.nppes.sync_run.completed",
    moduleOwner: "m29",
    description:
      "The platform NPPES sync finished walking every NPI (§4.10). Record-only.",
    payloadSchema: Type.Object({
      syncRunId: Type.String({ minLength: 1 }),
      completedAt: Type.String({ minLength: 1 }),
      providersFetched: Type.Integer({ minimum: 0 }),
      providersUpdated: Type.Integer({ minimum: 0 }),
      deactivations: Type.Integer({ minimum: 0 }),
      errors: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m29.nppes.sync_run.failed",
    moduleOwner: "m29",
    description:
      "The platform NPPES sync aborted — the §2.3 consecutive-failure circuit breaker tripped, or a fatal error escaped the NPI walk (§4.10). Record-only.",
    payloadSchema: Type.Object({
      syncRunId: Type.String({ minLength: 1 }),
      failedAt: Type.String({ minLength: 1 }),
      error: Type.String({ minLength: 1 }),
      providersFetched: Type.Integer({ minimum: 0 }),
      providersUpdated: Type.Integer({ minimum: 0 }),
      errors: Type.Integer({ minimum: 0 }),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
];
