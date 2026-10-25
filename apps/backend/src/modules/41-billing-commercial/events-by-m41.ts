import type { ModuleEventContribution } from "@chartwarden/types";
// apps/backend/src/modules/41-billing-commercial/events-by-m41.ts — Module 41's outbox-event contributions (ADR-0100 D9).
// `m41.<resource>.<verb>` names, owned by `m41`. The composition root merges this into the platform event catalog at boot
// and the dispatcher validates each publish against the payload schema inside the same transaction as the mutation.
//
// NO PHI in any payload: ids, the rule key and aggregate facts only (no member id, no authorization number, no reason text).
// RECORD-ONLY today (`declaredConsumers: []`): no module consumes these yet; the submission slice subscribes
// `m41.claim.ready_for_submission`, and declaring it before a handler exists would hold the row `pending` forever.
import { Type } from "@sinclair/typebox";

const id = Type.String({ minLength: 1 });

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
    eventName: "m41.claim.override_applied",
    moduleOwner: "m41",
    description:
      "A permitted person overrode one soft-block validation result with a recorded reason (audited; the reason text is never in this payload).",
    payloadSchema: Type.Object({ claimId: id, resultId: id, overrideId: id, ruleKey: id }),
    declaredConsumers: [],
    isOutboxOnly: true,
  },
];
