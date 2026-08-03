// apps/backend/src/modules/06-admission/outbox-consumers/live-binding.ts — the INTERIM
// `m6.admission-event-applier` outbox consumer (task-11 follow-up). M29's accept path now publishes
// `m29.hl7_inbound_proposal.accepted` (the TASK-006 emit wiring), and the dispatcher fails an event
// unless EVERY registered consumer succeeds — so M6 must stand a consumer BEFORE the emit ships, or
// m6-owned acceptances (external death notifications, HL7 withdrawals) would complete off M5's
// documented skip and vanish.
//
// THIS IS NOT THE APPLIER. The real §4.8.3 applier (decideAdmissionEvent facts resolution + the
// discharge/referral/compliance-window service execution + idempotency + the `m6.applier.refused`
// audit trail, W-M6-31..35) is a tracked follow-up. Until it lands:
//   · m5-owned payloads → SKIP (M5's own consumer applies them; skipping keeps multi-consumer
//     retries idempotent — neither consumer throws on the other's events).
//   · m6-owned payloads → THROW. The dispatcher retries then DEAD-LETTERS, so an accepted external
//     death/discharge stays a VISIBLE failed row an operator can replay once the applier lands —
//     never a silently completed no-op against a patient's admission record.
export interface M6AdmissionEventApplierBinding {
  readonly consumerName: "m6.admission-event-applier";
  readonly eventTypes: readonly ["m29.hl7_inbound_proposal.accepted"];
  handle(event: { readonly payload: unknown; readonly organizationId: string }): Promise<void>;
}

/** Build the interim consumer the composition root registers with the outbox dispatcher. */
export function buildM6ProposalAcceptedConsumer(): M6AdmissionEventApplierBinding {
  return {
    consumerName: "m6.admission-event-applier",
    eventTypes: ["m29.hl7_inbound_proposal.accepted"],
    async handle(event) {
      const owner = (event.payload as { ownerModule?: unknown } | null)?.ownerModule;
      if (owner !== "m6") return; // M5's consumer owns the rest — see the header's idempotency rule
      throw new Error(
        "m6.admission-event-applier: the §4.8.3 admission-event applier is not yet wired (facts + service execution, W-M6-31..35) — dead-lettering so the accepted external event stays visible and replayable",
      );
    },
  };
}
