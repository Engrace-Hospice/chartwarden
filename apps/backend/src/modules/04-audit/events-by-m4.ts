// apps/backend/src/modules/04-audit/events-by-m4.ts — Module 4's outbox-event contribution
// (GAP-003, M4 spec §7 M04-F03). The `m4.*` taxonomy under the `m4.` namespace (M01 D8 / M03 D9 /
// M04 D9). check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`), ownership
// (moduleOwner='m4') and valid declared consumers; the composition root merges it into the platform
// catalog at boot (the M15/M16/M19/… events-by-mN precedent).
//
// `declaredConsumers` is `[]` for both events: M04-F03 defines a `HoldApplier` seam
// (`applyHold(criteria)`/`releaseHold(criteria)`, interface in `packages/types`) that each
// data-class-owning module is meant to register so a legal hold propagates beyond `audit_event`
// itself — but no module has registered one yet, so today these events are catalog-validated and
// persisted with no subscriber. Declaring a consumer that doesn't exist would be a namespace lie;
// `[]` is the honest broadcast/no-consumer shape (the same one `m29.hl7_inbound_proposal.rejected`
// uses for "a durable record; no consumer applies anything").
import { Type } from "@sinclair/typebox";
import type { ModuleEventContribution } from "@wardenx/types";

const HoldEventPayload = Type.Object({
  holdId: Type.String({ minLength: 1 }),
  matched: Type.Integer({ minimum: 0 }),
  reason: Type.String({ minLength: 1 }),
});

export const M4_OUTBOX_EVENTS: ModuleEventContribution = [
  {
    eventName: "m4.legal_hold.applied",
    moduleOwner: "m4",
    description:
      "A legal hold was applied (§10.6, M04-F03). `matched` is the live count of currently-matching " +
      "audit_event rows at apply time — no other module's data is physically flipped yet (see " +
      "legal-holds.ts's file header).",
    payloadSchema: HoldEventPayload,
    // F-139 (#248) — considered adding `m31` (its spec names this event with a real consumer file that
    // suspends eraser execution) and reverted: this module's OWN header above and `legal-holds.ts`'s
    // (M04-F03) are decisive that propagation is a registered `HoldApplier` SEAM per data-owning module,
    // never an outbox subscription — "Declaring a consumer that doesn't exist would be a namespace lie."
    // M31 registering a `HoldApplier` is real, unbuilt work, but it is not an outbox catalog fix.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
  {
    eventName: "m4.legal_hold.released",
    moduleOwner: "m4",
    description:
      "A legal hold was released (§10.6, M04-F03); `matched` mirrors the apply-time count.",
    payloadSchema: HoldEventPayload,
    // F-139 (#248) — same reversal as `.applied` above: `HoldApplier` seam, not an outbox consumer.
    declaredConsumers: [],
    isOutboxOnly: true,
  },
];
