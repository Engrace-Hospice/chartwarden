import type { ModuleEventContribution } from "@chartwarden/types";
// apps/backend/src/modules/41-billing-commercial/events-by-m41.ts — Module 41's outbox-event contributions (ADR-0100 D9).
// `m41.<resource>.<verb>` names, owned by `m41`. The composition root merges this into the platform event catalog at boot
// and the dispatcher validates each publish against the payload schema inside the same transaction as the mutation.
//
// NO PHI in any payload: ids, the rule key and aggregate facts only (no member id, no authorization number, no reason text).
// RECORD-ONLY today (`declaredConsumers: []`): no module consumes these yet. The submission drain reads its own durable
// `commercial_submission` rows instead of subscribing, and declaring a consumer before a handler exists would hold the row
// `pending` forever.
import { Type } from "@sinclair/typebox";

const id = Type.String({ minLength: 1 });

/** The acknowledgment events: ids, the stage and the vendor's reason CODES (never text). */
const ackPayload = Type.Object({
  claimId: id,
  submissionId: id,
  stage: Type.Union([Type.Literal("clearinghouse"), Type.Literal("payer")]),
  reasonCodes: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 50 }),
});

export const M41_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m41.claim.draft_created",
    moduleOwner: "m41",
    description:
      "A commercial claim DRAFT was assembled from the shared claim facts and the payer plan, and its first validation run recorded.",
    payloadSchema: Type.Object({
      claimId: id,
      providerEntityId: id,
      patientId: id,
      planId: id,
      tob: Type.String(),
      serviceFrom: id,
      serviceTo: id,
      secondaryPayerKind: Type.Union([
        Type.Literal("medicare"),
        Type.Literal("medicaid"),
        Type.Null(),
      ]),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m41.claim.ready_for_submission",
    moduleOwner: "m41",
    description:
      "Validation completed with no unresolved block (every hard block passed, every soft block overridden); the claim moved draft to ready.",
    payloadSchema: Type.Object({ claimId: id, validationRunId: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m41.claim.submit_requested",
    moduleOwner: "m41",
    description:
      "The send gate passed and a submission of a ready commercial claim was queued for the clearinghouse transport. Nothing has been sent yet and the claim is still ready.",
    payloadSchema: Type.Object({
      claimId: id,
      submissionId: id,
      controlNumber: id,
      clearinghouseKey: id,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m41.claim.submitted",
    moduleOwner: "m41",
    description:
      "The clearinghouse transport ACCEPTED the claim file (a receipt exists); the claim moved ready to submitted. Clearinghouse and payer acceptance are separate, later events.",
    payloadSchema: Type.Object({
      claimId: id,
      submissionId: id,
      controlNumber: id,
      clearinghouseKey: id,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m41.claim.submit_failed",
    moduleOwner: "m41",
    description:
      "A queued submission ended without the transport accepting it (a refusal, retries exhausted, or an in-doubt send that needs reconciling). The claim stays ready; code is a stable machine code, never vendor text.",
    payloadSchema: Type.Object({
      claimId: id,
      submissionId: id,
      status: Type.Union([Type.Literal("failed"), Type.Literal("in_doubt")]),
      code: id,
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m41.claim.submit_reconciled",
    moduleOwner: "m41",
    description:
      "A person settled a submission that was in doubt: `received` (the claim is filed; it moved ready to submitted) or `not_received` (the submission failed and the claim may be sent again). No free text is taken.",
    payloadSchema: Type.Object({
      claimId: id,
      submissionId: id,
      outcome: Type.Union([Type.Literal("received"), Type.Literal("not_received")]),
      // what the person relied on when confirming receipt (a closed set); null for not_received
      evidence: Type.Union([
        Type.Literal("clearinghouse_portal"),
        Type.Literal("payer_portal"),
        Type.Literal("vendor_support"),
        Type.Null(),
      ]),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m41.claim.clearinghouse_accepted",
    moduleOwner: "m41",
    description:
      "The clearinghouse (999 stage) accepted the file; the claim moved submitted to ack_pending. This is NOT payer acceptance.",
    payloadSchema: ackPayload,
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m41.claim.accepted",
    moduleOwner: "m41",
    description:
      "The PAYER (277CA stage) accepted the claim; the claim moved to accepted. Adjudication and payment are separate, later states.",
    payloadSchema: ackPayload,
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m41.claim.rejected",
    moduleOwner: "m41",
    description:
      "The clearinghouse or the payer rejected the claim (or the payer accepted only part of it); the claim moved to rejected. Reason codes only.",
    payloadSchema: ackPayload,
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m41.claim.adjudicated",
    moduleOwner: "m41",
    description:
      "A posted 835 line moved the claim to paid, partially_paid or denied (the M41 consumer of m25.remittance.claim_paid / claim_partial_paid / claim_denied). Ids and the outcome only; the money lives in M25.",
    payloadSchema: Type.Object({
      claimId: id,
      remittanceAdviceId: id,
      outcome: Type.Union([
        Type.Literal("paid"),
        Type.Literal("partially_paid"),
        Type.Literal("denied"),
      ]),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m41.claim.ack_abandoned",
    moduleOwner: "m41",
    description:
      "A held acknowledgment left the quarantine WITHOUT being applied (its submission is gone or belongs elsewhere, it aged past the 45-day window, or it no longer validates). It may be the only proof a file arrived, so the abandonment is an event, not a log line. `statusInquiry` says what the claim-status inquiry made of an aged one. Ids and codes only.",
    payloadSchema: Type.Object({
      eventId: id,
      controlNumber: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
      claimId: Type.Union([id, Type.Null()]),
      reason: Type.Union([
        Type.Literal("no_receipt"),
        Type.Literal("scope_mismatch"),
        Type.Literal("vendor_mismatch"),
        Type.Literal("malformed"),
      ]),
      resolution: Type.Union([
        Type.Literal("abandoned_operator"),
        Type.Literal("abandoned_no_submission"),
        Type.Literal("abandoned_scope_mismatch"),
        Type.Literal("abandoned_vendor_mismatch"),
        Type.Literal("abandoned_aged"),
        Type.Literal("abandoned_invalid"),
        Type.Literal("abandoned_no_event"),
        Type.Literal("abandoned_foreign_vendor"),
      ]),
      statusInquiry: Type.Union([
        Type.Literal("not_attempted"),
        Type.Literal("unavailable"),
        Type.Literal("no_answer"),
        Type.Literal("applied"),
      ]),
      /** Present only for an operator-driven closure (`abandoned_operator`, `abandoned_foreign_vendor` via the route). */
      operatorUserId: Type.Optional(id),
    }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m41.claim.override_applied",
    moduleOwner: "m41",
    description:
      "A permitted person overrode one soft-block validation result with a recorded reason (audited; the reason text is never in this payload).",
    payloadSchema: Type.Object({ claimId: id, resultId: id, overrideId: id, ruleKey: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
];
