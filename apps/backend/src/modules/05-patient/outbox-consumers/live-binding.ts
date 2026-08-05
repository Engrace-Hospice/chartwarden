// apps/backend/src/modules/05-patient/outbox-consumers/live-binding.ts — the LIVE
// `m5.proposal-applier` outbox consumer (TASK-006). Composes the pure §4.10 decision core
// ({@link decideProposalApply}) with the live PatientMutator seam, for the boot outbox dispatcher
// to route `m29.hl7_inbound_proposal.accepted` events to.
//
// TODAY THIS CONSUMER IS CORRECTLY IDLE: M29's accept path updates the proposal row but does not
// yet publish the event to the outbox (its emit wiring is an M29 follow-up — M29_OUTBOX_EVENTS is
// not in the boot catalog). Registering the consumer NOW means the moment that emit lands, accepted
// demographic updates flow to the chart with no further wiring.
//
// FAIL DIRECTIONS (each deliberate):
//   · `apply_demographics` → PatientMutator.apply (forbidden fields stripped there, W-M5-17). A
//     mutator throw propagates → the dispatcher retries with backoff → DLQ. Never swallowed.
//   · `create_patient` → THROWS: the headless create/match path is not wired. An accepted
//     new-patient proposal must dead-letter LOUDLY (a visible failed row) rather than vanish.
//   · `skip` (not m5-owned / no match) → success. NOTE the m6-owned arm: M6's applier is still a
//     deferred binding — it must land as a SECOND consumer on this event type before M29's emit
//     wiring ships, or m6-owned acceptances will be marked dispatched off this consumer's skip.
//   · A payload that does not parse → THROWS (retry → DLQ): a malformed accepted-proposal event is
//     an integration defect to surface, not to drop.
import { getSeam } from "../../../bootstrap/index";
import { type ProposalAcceptedPayload, decideProposalApply } from "./m29-proposal-accepted";

/** Structural binding (matches the dispatcher's OutboxConsumerBinding without importing it). */
export interface M5ProposalApplierBinding {
  readonly consumerName: "m5.proposal-applier";
  readonly consumerModule: "m5";
  readonly eventTypes: readonly ["m29.hl7_inbound_proposal.accepted"];
  handle(event: { readonly payload: unknown; readonly organizationId: string }): Promise<void>;
}

function parsePayload(raw: unknown, organizationId: string): ProposalAcceptedPayload {
  const p = raw as Partial<ProposalAcceptedPayload> | null;
  if (
    !p ||
    typeof p.proposalId !== "string" ||
    typeof p.organizationId !== "string" ||
    (p.resourceKind !== "patient_demographic_update" && p.resourceKind !== "new_patient") ||
    (p.ownerModule !== "m5" && p.ownerModule !== "m6") ||
    typeof p.decidedByMembershipId !== "string" ||
    typeof p.proposedPatientCandidate !== "object"
  ) {
    throw new Error(
      `m5.proposal-applier: malformed m29.hl7_inbound_proposal.accepted payload (proposal ${String(
        p?.proposalId,
      )}) — refusing to guess`,
    );
  }
  if (p.organizationId !== organizationId) {
    throw new Error(
      `m5.proposal-applier: payload org ${p.organizationId} != outbox row org ${organizationId} — refusing a cross-tenant apply`,
    );
  }
  return p as ProposalAcceptedPayload;
}

/** Build the live consumer the composition root registers with the outbox dispatcher. */
export function buildM29ProposalApplierConsumer(): M5ProposalApplierBinding {
  return {
    consumerName: "m5.proposal-applier",
    consumerModule: "m5",
    eventTypes: ["m29.hl7_inbound_proposal.accepted"],
    async handle(event) {
      // Owner sniff BEFORE the strict parse: an m6-owned acceptance carries admission resource
      // kinds this parser rightly rejects — but that is M6's applier's business, not a malformed
      // event. M5 skips everything it does not own without judging its shape.
      const owner = (event.payload as { ownerModule?: unknown } | null)?.ownerModule;
      if (owner !== "m5") return;
      const payload = parsePayload(event.payload, event.organizationId);
      const decision = decideProposalApply(payload);
      switch (decision.action) {
        case "apply_demographics": {
          await getSeam("PatientMutator").apply({
            organizationId: payload.organizationId,
            patientId: decision.patientId,
            patch: decision.patch,
            source: "m29_proposal_accept",
            sourceRef: { kind: "hl7_inbound_proposal", id: payload.proposalId },
            // The reviewer whose accept decision this apply executes (carried on the payload).
            actorMembershipId: payload.decidedByMembershipId,
          });
          return;
        }
        case "create_patient":
          throw new Error(
            "m5.proposal-applier: headless patient CREATE is not wired (the create/match path needs the intake service) — dead-lettering so the acceptance stays visible",
          );
        case "skip":
          return; // documented no-op (not m5-owned, or a demographic update with no match — D10)
      }
    },
  };
}
