// @chartwarden/billing — schemas for route #8 `POST /api/v1/billing/claims/:id:replace` (§4.1, D14).
//
// Builds a TOB 817 (replacement) referencing this claim; returns the NEW claim id in DRAFT. Step-up auth
// required. The predecessor must be in a replaceable terminal/adjudicated state (server-enforced).
import { type Static, Type } from "@sinclair/typebox";
import { IfVersion, IsoDateTimeSchema, Uuid } from "./common";

export const ClaimReplaceRequest = Type.Object({
  ifVersion: IfVersion,
  /** Typed reason for the replacement (audit narrative; ≥20 chars). */
  reason: Type.String({ minLength: 20, maxLength: 2000 }),
});
export type ClaimReplaceRequest = Static<typeof ClaimReplaceRequest>;

export const ClaimReplaceResponse = Type.Object({
  /** The new DRAFT TOB-817 claim. */
  replacementClaimId: Uuid,
  /** The predecessor claim, now transitioned toward `REPLACED` on the replacement's acceptance. */
  replacesClaimId: Uuid,
  state: Type.Literal("DRAFT"),
  tob: Type.Literal("817"),
  createdAt: IsoDateTimeSchema,
});
export type ClaimReplaceResponse = Static<typeof ClaimReplaceResponse>;

// Errors (per §4.2 patterns):
//   409 CLAIM_NOT_REPLACEABLE — predecessor is not in an adjudicated/replaceable state
//   412 STALE_VERSION         — If-Match / ifVersion mismatch
//   403 STEP_UP_REQUIRED      — M2 billing-submit session profile not satisfied
