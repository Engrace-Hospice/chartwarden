// @wardenx/billing — schemas for route #4 `PATCH /api/v1/billing/claims/:id` (DRAFT-only edits) and
// route #5 `DELETE /api/v1/billing/claims/:id` (DRAFT-only delete) — §4.1.
//
// DRAFT-only: the TOB choice and a rationale-bearing override of an assembly-time auto-derived value. All
// edits carry `ifVersion` (optimistic concurrency, §2.5). Non-DRAFT targets 409.
import { type Static, Type } from "@sinclair/typebox";
import { ClaimStateApi, ClaimTobAssemblable, IfVersion, Uuid } from "./common";

export const ClaimIdParams = Type.Object({ id: Uuid });
export type ClaimIdParams = Static<typeof ClaimIdParams>;

export const ClaimUpdateRequest = Type.Object({
  ifVersion: IfVersion,
  /** Optional TOB re-choice within the assemblable set (817/818 stay on :replace / :void). */
  tob: Type.Optional(ClaimTobAssemblable),
  /** A rationale-bearing override of an assembly-time auto-derived value (≥20 chars when present). */
  overrides: Type.Optional(
    Type.Array(
      Type.Object({
        field: Type.String(),
        value: Type.Unknown(),
        rationale: Type.String({ minLength: 20, maxLength: 2000 }),
      }),
      { maxItems: 32 },
    ),
  ),
});
export type ClaimUpdateRequest = Static<typeof ClaimUpdateRequest>;

export const ClaimUpdateResponse = Type.Object({
  claimId: Uuid,
  state: ClaimStateApi,
  version: Type.Integer(),
});
export type ClaimUpdateResponse = Static<typeof ClaimUpdateResponse>;

export const ClaimDeleteResponse = Type.Object({
  claimId: Uuid,
  deleted: Type.Literal(true),
});
export type ClaimDeleteResponse = Static<typeof ClaimDeleteResponse>;

// Errors (per §4.2 patterns):
//   409 CLAIM_NOT_DRAFT — target is not in DRAFT (no edits/deletes once it leaves DRAFT)
//   412 STALE_VERSION   — If-Match / ifVersion mismatch
