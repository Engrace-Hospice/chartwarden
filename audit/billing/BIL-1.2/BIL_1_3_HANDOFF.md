# BIL-1.3 handoff — M23/M41 acknowledgment integration and status provenance

BIL-1.3 may consume only a `resolved` identity record whose `(accountReference, usage, organizationId, providerEntityId, claimId, module, submissionId, submissionAttemptId)` target is server-verified and backed by immutable send-time identity evidence. Event `responseId` remains the event idempotency key; Claim.MD normalized status origin must remain explicit and must not be relabeled as a literal 999/277CA document without that evidence.

Before dispatch implementation:

1. Complete at-send account/environment, Claim.MD route, upload receipt, payer, claim type, NPI, and encrypted TIN snapshot persistence for new M23/M41 sends; preserve historical rows as unresolved where evidence is absent.
2. Build and live-test the cross-module candidate adapter for M23, M41, and only confirmed Claim.MD M24 submissions.
3. Certify the deployed Claim.MD meaning and uniqueness of `fileid`, `claimmd_id`, `remote_claimid`, `claimid`, PCN, and message-level `responseid` in the actual single-claim upload workflow.
4. Bind internal identity service securely with feature flag disabled by default, worker monitoring, replay, DLQ/review operations, and database role evidence.
5. Keep M23 Medicare stage transitions separate from M41 commercial transitions. Medicaid state-direct transports remain unchanged. Do not post ERA or payments in BIL-1.3.

Consumer guarantees: consume resolved records only; idempotency by inbox event ID + account/environment + origin; validate current immutable mapping version; no raw inbox access from tenant code; quarantine conflict/unresolved records; never move the BIL-1.1 cursor; preserve provenance; claim-state update and delivery receipt must be atomic within the owning billing module.
