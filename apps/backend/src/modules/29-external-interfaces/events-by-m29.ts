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
];
