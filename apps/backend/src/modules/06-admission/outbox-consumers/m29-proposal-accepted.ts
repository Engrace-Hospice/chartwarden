// apps/backend/src/modules/06-admission/outbox-consumers/m29-proposal-accepted.ts — the M29
// proposal-accept consumer binding (M6-T11, spec §4.8.3). PHASE-1 FORWARD-SEAM / DENY-STUB.
//
// M29 (HL7/ADT interop) is Wave H — there is no `m29.hl7_inbound_proposal.accepted` producer yet, so
// this binding is DECLARED (the contract M29 will dispatch to) but is NOT live-wired into the boot
// outbox dispatcher. The DECISION logic ships now, pure + tested, in
// ./../consumers/admission-event-applier.ts ({@link decideAdmissionEvent}). Wiring M29 later
// (§7.7 W-M6-31..35) is binding this handler to the decider and executing each returned
// {@link ApplierAction} through M6's `dischargeService` / `referralService` / `complianceWindowService`
// (recordExternalDeath, markWithdrawnFromHl7, complianceWindowService.create) so the state machines
// stay authoritative — plus the idempotency/refusal audit rows and the `m6.applier.refused` emit.
//
// Note the event name is a STRING literal only (no M29 schema import): M6 reads M29 solely through the
// foundation outbox, never via a `dependsOn` edge (§4 boundary rule). The file lives under
// outbox-consumers/ (not events-by-m6.ts) so the arch:gaps event-catalog scan does not treat the
// consumed `m29.*` name as an M6-produced event.
import type { ApplierAction, ApplierFacts, ProposalAcceptedPayload } from "../consumers/admission-event-applier";
import { decideAdmissionEvent } from "../consumers/admission-event-applier";

/** The forward-declared (event → consumer) binding M29 dispatches to once it lands (Wave H, §4.8.3). */
export const M6_PROPOSAL_ACCEPTED_CONSUMER = {
  eventName: "m29.hl7_inbound_proposal.accepted",
  consumerName: "m6.admission-event-applier",
} as const;

/** True in Phase 1 — no M29 producer; the consumer is declared but not live-wired into the dispatcher. */
export const M6_PROPOSAL_ACCEPTED_CONSUMER_DEFERRED = true;

/**
 * The pure decision the live (Wave-H) handler runs per delivery: resolve {@link ApplierFacts} from
 * M6's read seams + audit log, then call this to get the {@link ApplierAction} to execute. Kept as a
 * one-line re-export so the boot wiring (when M29 lands) reads `decideProposalAccepted(payload, facts)`.
 */
export function decideProposalAccepted(payload: ProposalAcceptedPayload, facts: ApplierFacts): ApplierAction {
  return decideAdmissionEvent(payload, facts);
}
