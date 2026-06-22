// apps/backend/src/modules/07-care-plan/outbox-consumers/m14-idg-decision-recorded.ts — the M14 IDG
// consumer binding (M7-T08, spec §7.9 / §11 D4). PHASE-1 FORWARD-SEAM / DENY-STUB.
//
// M14 (IDG) is Wave F — there is no `idg.decision_recorded` producer yet, so this binding is DECLARED
// (the contract M14 will dispatch to) but is NOT live-wired into the boot outbox dispatcher. The
// DECISION logic ships now, pure + tested, in ./../consumers/apply-idg-decision.ts
// ({@link decideIdgDecision}). Wiring M14 later is binding this handler to the decider and executing the
// returned {@link IdgApplyAction} through M7's version + element services (open a draft `idg_review`
// version, apply each {@link PlannedElementMutation}, mark `idg_meeting_id`) — plus the idempotency
// (`care_plan.idg_decision_applied`) audit row and the coordinator notification.
//
// The event name is a STRING literal only (no M14 schema import): M7 reads M14 solely through the
// foundation outbox, never via a `dependsOn` edge (§4 boundary rule). M14 (Wave F) owns the canonical
// wire name and the typed payload (`packages/types` `IdgDecisionPayload`); this binding string is the
// single point to reconcile if M14 namespaces it under the `mN.` event convention. The file lives under
// outbox-consumers/ (not events-by-m7.ts) so the arch:gaps event-catalog scan does not treat the
// consumed `idg.decision_recorded` name as an M7-produced event.
import type { IdgDecisionPayload } from "@wardenx/types";
import type { IdgApplyAction, IdgApplyFacts } from "../consumers/apply-idg-decision";
import { decideIdgDecision } from "../consumers/apply-idg-decision";

/** The forward-declared (event → consumer) binding M14 dispatches to once it lands (Wave F, §7.9). */
export const M7_IDG_DECISION_CONSUMER = {
  eventName: "idg.decision_recorded",
  consumerName: "m7.apply-idg-decision",
} as const;

/** True in Phase 1 — no M14 producer; the consumer is declared but not live-wired into the dispatcher. */
export const M7_IDG_DECISION_CONSUMER_DEFERRED = true;

/**
 * The pure decision the live (Wave-F) handler runs per delivery: resolve {@link IdgApplyFacts} from the
 * idempotency audit log + the care-plan aggregate, then call this to get the {@link IdgApplyAction} to
 * execute. Kept as a one-line re-export so the boot wiring (when M14 lands) reads
 * `decideIdgDecisionRecorded(payload, facts)`.
 */
export function decideIdgDecisionRecorded(
  payload: IdgDecisionPayload,
  facts: IdgApplyFacts,
): IdgApplyAction {
  return decideIdgDecision(payload, facts);
}
