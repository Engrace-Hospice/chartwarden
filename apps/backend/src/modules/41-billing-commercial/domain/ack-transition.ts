// apps/backend/src/modules/41-billing-commercial/domain/ack-transition.ts - what an acknowledgment does to a claim (ADR-0053 D2,
// ADR-0100 D9). PURE.
//
//   submitted    --clearinghouse accepted-->  ack_pending      (the vendor has the file; the payer has not answered)
//   submitted    --payer accepted---------->  accepted         (delivery order is not guaranteed: a 277CA may precede the 999)
//   ack_pending  --payer accepted---------->  accepted
//   submitted | ack_pending --any rejection--> rejected        (clearinghouse reject, payer reject, payer partial)
//
// A clearinghouse acceptance NEVER reaches `accepted`. A claim that is not `submitted` or `ack_pending` (already accepted or
// rejected, or never sent) does not move: the acknowledgment is still recorded, the claim is unchanged.
import type { CommercialClaimState } from "@chartwarden/types";

export type AckStage = "clearinghouse" | "payer";
export type AckDisposition = "accepted" | "rejected" | "partial";

export type AckEventName =
  | "m41.claim.clearinghouse_accepted"
  | "m41.claim.accepted"
  | "m41.claim.rejected";

export interface AckTransition {
  readonly to: Extract<CommercialClaimState, "ack_pending" | "accepted" | "rejected">;
  readonly event: AckEventName;
}

export function transitionForAck(
  current: string,
  stage: AckStage,
  disposition: AckDisposition,
): AckTransition | null {
  if (current !== "submitted" && current !== "ack_pending") return null;
  if (disposition === "rejected" || disposition === "partial") {
    return { to: "rejected", event: "m41.claim.rejected" };
  }
  if (stage === "clearinghouse") {
    return current === "submitted"
      ? { to: "ack_pending", event: "m41.claim.clearinghouse_accepted" }
      : null;
  }
  return { to: "accepted", event: "m41.claim.accepted" };
}
