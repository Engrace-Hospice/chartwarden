// apps/backend/src/modules/08-encounters/outbox-consumers/m17-visit-scheduled.ts — the M17 visit-
// scheduling consumer binding (M8-T11, spec §4.7 / line 65). PHASE-1 FORWARD-SEAM / DENY-STUB.
//
// M17 (Scheduling) is Wave F — there is no `m17.visit.scheduled` producer yet, so this binding is
// DECLARED (the contract M17 will dispatch to) but is NOT live-wired into the boot outbox dispatcher.
// The DECISION logic ships now, pure + tested, in ./../consumers/seed-visit-encounter.ts
// ({@link decideVisitSeeding}). Wiring M17 later is binding this handler to the decider and executing
// the returned {@link VisitSeedingAction} through M8's published `EncounterCreator` seam (open a draft
// `encounter` for an active-service patient) — plus the idempotency check (a draft already bracketing
// the visit) and the skip-reason audit row for the M17 reconciliation worklist.
//
// The event name is a STRING literal only (no M17 schema import): M8 reads M17 solely through the
// foundation outbox, never via a `dependsOn` edge (§4 boundary rule), so M17 (17) stays OUT of M8's
// manifest `dependsOn`. M17 (Wave F) owns the canonical wire name + typed payload; this binding string
// is the single point to reconcile if M17 namespaces it differently. The file lives under
// outbox-consumers/ (not events-by-m8.ts) so the arch:gaps event-catalog scan does not treat the
// consumed `m17.visit.scheduled` name as an M8-produced event.
import type {
  VisitScheduledPayload,
  VisitSeedingAction,
  VisitSeedingFacts,
} from "../consumers/seed-visit-encounter";
import { decideVisitSeeding } from "../consumers/seed-visit-encounter";

/** The forward-declared (event → consumer) binding M17 dispatches to once it lands (Wave F, §4.7). */
export const M8_VISIT_SCHEDULED_CONSUMER = {
  eventName: "m17.visit.scheduled",
  consumerName: "m8.seed-visit-encounter",
} as const;

/** True in Phase 1 — no M17 producer; the consumer is declared but not live-wired into the dispatcher. */
export const M8_VISIT_SCHEDULED_CONSUMER_DEFERRED = true;

/**
 * The pure decision the live (Wave-F) handler runs per delivery: resolve {@link VisitSeedingFacts} from
 * M8's `encounter` table (idempotency) + the M6 `AdmissionStatusReader` (active service), then call this
 * to get the {@link VisitSeedingAction} to execute through `EncounterCreator`. Kept as a one-line
 * re-export so the boot wiring (when M17 lands) reads `decideVisitScheduled(payload, facts)`.
 */
export function decideVisitScheduled(
  payload: VisitScheduledPayload,
  facts: VisitSeedingFacts,
): VisitSeedingAction {
  return decideVisitSeeding(payload, facts);
}
