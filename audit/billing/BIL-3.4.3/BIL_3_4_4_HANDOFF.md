# BIL-3.4.4 handoff

Build the approved-plan workflow on the internal `postValidatedClaimInTransaction` seam only after defining and testing the source-owned adapter from the encrypted Claim.MD stage to the validated M25 financial source facts. The future caller must verify the stage, ownership and match/review revisions, authorization, plan digest, posting approval and cross-source effect identity before invoking the core within its own short `withOrgContext` transaction.

Before widening the narrow claim-level case, add evidence and accounting tests for each new financial fact. The current explicit core rejects line/service allocation, adjustments, PLB, reversals, recoupments and incomplete/unknown source content. No approval, route, UI, worker, or Claim.MD stage-to-posting bridge exists in this phase. Keep all Claim.MD posting configuration disabled.
