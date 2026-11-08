# BIL-1.3 acknowledgment handoff

## Resolved event identity contract

A resolver decision is eligible for BIL-1.3 only when `claimmd_response_resolution.state='resolved'` and the row contains organization, provider entity, claim, module, submission ID, submissionAttemptId, strategy, account/environment implied by its source stream, algorithm version, and `evidence_ref.evidenceId`. `submissionAttemptId` identifies the immutable evidence attempt row. BIL-1.3 must load the original encrypted inbox event by event UUID; resolution is identity only and currently carries no acknowledgment disposition or status.

Keep each captured message-level `responseid` distinct even when messages share the parent claim. Preserve raw origin and normalized vendor source status. Do not create a 999/277CA unless Claim.MD status has a verified faithful mapping with its origin retained. An upload receipt or identity match does not imply clearinghouse acceptance, payer acceptance, denial, payment, or posting.

## Preconditions

Before dispatch implementation is activated, pass private DB role/RLS/concurrency tests; prove synthetic M23 and M41 end-to-end resolution; verify response-to-attempt namespace semantics with Claim.MD fixtures; resolve BIL-1.1 capture runtime ownership; retain disabled-by-default rollout controls; and add module-specific dispatch gates. M23 regulatory notices require their own immutable evidence path. M24 state-direct workflows remain independent. M25 remains out of scope.
