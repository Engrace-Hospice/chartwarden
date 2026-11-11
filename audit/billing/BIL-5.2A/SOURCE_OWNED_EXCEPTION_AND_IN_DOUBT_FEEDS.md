# Source-owned exception and in-doubt projections

- M23 claim-list projection reads `claim_submission` only for claim IDs on the already authorized page, constrained by the request organization and `dispatch_state = in_doubt`. It exposes the attempt identity/index, safe reason code and source attempt-start time (falling back to the recorded creation time for legacy rows). Claim list provider scoping remains in the M23 repository path.
- M41 claim-list projection reads `commercial_submission` only for already returned claim IDs, with organization and provider predicates and the M41 claim join. It exposes attempt ID/count, last safe failure code and update time. Existing list caseload checks happen before this projection.
- M24 currently has no supported in-doubt transport state; it is not synthesized.
- M25's existing tenant-scoped ERA stage projection remains the source for held, duplicate and identity-exception summaries. Detailed financial blockers remain in M25 review.

The projections are bounded by the existing owner claim page. They are not complete historical in-doubt queues: an old uncertain attempt attached to a claim outside the current page is not returned. A dedicated submission-first cursor API is still required for complete operational coverage.
