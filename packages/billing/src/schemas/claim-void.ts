// @wardenx/billing — schemas for route #9 `POST /api/v1/billing/claims/:id:void` (§4.1, D14).
//
// Builds a TOB 818 (void/cancel) referencing this claim; returns the NEW claim id in DRAFT. Step-up auth
// required. The predecessor must be in a voidable adjudicated state (server-enforced).
import { type Static, Type } from "@sinclair/typebox";
import { IfVersion, IsoDateTimeSchema, Uuid } from "./common";

export const ClaimVoidRequest = Type.Object({
  ifVersion: IfVersion,
  /** Typed reason for the void (audit narrative; ≥20 chars). */
  reason: Type.String({ minLength: 20, maxLength: 2000 }),
});
export type ClaimVoidRequest = Static<typeof ClaimVoidRequest>;

export const ClaimVoidResponse = Type.Object({
  /** The new DRAFT TOB-818 claim. */
  voidClaimId: Uuid,
  /** The predecessor claim, transitioned toward `VOIDED` on the void's acceptance. */
  voidsClaimId: Uuid,
  state: Type.Literal("DRAFT"),
  tob: Type.Literal("818"),
  createdAt: IsoDateTimeSchema,
});
export type ClaimVoidResponse = Static<typeof ClaimVoidResponse>;

// Errors (per §4.2 patterns):
//   409 CLAIM_NOT_VOIDABLE — predecessor is not in an adjudicated/voidable state
//   412 STALE_VERSION      — If-Match / ifVersion mismatch
//   403 STEP_UP_REQUIRED   — M2 billing-submit session profile not satisfied
