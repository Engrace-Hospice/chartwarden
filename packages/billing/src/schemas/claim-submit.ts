// @wardenx/billing — schemas for route #7 `POST /api/v1/billing/claims/:id:submit` (§4.1 / §4.2).
//
// READY → SUBMITTED; emits `m23.claim.submit_requested`; M2 step-up auth is required (D2). The service
// re-asserts the blocking guard server-side (every fail-without-override blocks); `acknowledgeAllOverrides`
// is a belt-and-suspenders client attestation, not the authority.
import { type Static, Type } from "@sinclair/typebox";
import { IfVersion, IsoDateTimeSchema, Uuid } from "./common";

export const ClaimSubmitRequest = Type.Object({
  ifVersion: IfVersion,
  acknowledgeAllOverrides: Type.Boolean({ default: false }),
});
export type ClaimSubmitRequest = Static<typeof ClaimSubmitRequest>;

export const ClaimSubmitResponse = Type.Object({
  claimId: Uuid,
  state: Type.Literal("SUBMITTED"),
  claimControlNumber: Type.String(),
  submissionId: Uuid,
  enqueuedAt: IsoDateTimeSchema,
});
export type ClaimSubmitResponse = Static<typeof ClaimSubmitResponse>;

// Errors (per §4.2):
//   409 CLAIM_NOT_READY             — state != READY
//   412 STALE_VERSION               — If-Match / ifVersion mismatch
//   422 VALIDATION_FAILURES_PRESENT — last run.outcome != ready_for_submission (response lists failing keys)
//   403 STEP_UP_REQUIRED            — M2 billing-submit session profile not satisfied
//   503 MAC_PORTAL_UNAVAILABLE      — claim still moves to SUBMITTED; submission queues (Tier-2 fallback)
