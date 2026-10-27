// apps/backend/src/modules/41-billing-commercial/domain/remittance-transition.ts - what a posted 835 line does to a commercial claim
// (ADR-0100 D8 amendment, #835). PURE; mirrors the legal moves of the m41_commercial_claim_state_guard trigger (migration 1283).
//
//   submitted | ack_pending | accepted --> paid | partially_paid | denied   (an 835 may beat the payer's acknowledgment)
//   partially_paid --> paid                                                  (the balance arrived)
//   denied         --> paid | partially_paid                                 (appeal or payer reprocess re-posts with money)
//
// Never regress: paid is final (a later denial or partial line does not undo it; a recoupment is M25's ledger, not a claim state),
// partially_paid never becomes denied. Anything else (draft, ready, rejected, void, same state) is a settled no-op.
import type { CommercialClaimState } from "@chartwarden/types";

export type RemittanceOutcome = Extract<CommercialClaimState, "paid" | "partially_paid" | "denied">;

const SENT: ReadonlySet<string> = new Set(["submitted", "ack_pending", "accepted"]);

export function transitionForRemittance(
  current: string,
  outcome: RemittanceOutcome,
): RemittanceOutcome | null {
  if (SENT.has(current)) return outcome;
  if (current === "partially_paid" && outcome === "paid") return "paid";
  if (current === "denied" && (outcome === "paid" || outcome === "partially_paid")) return outcome;
  return null;
}
