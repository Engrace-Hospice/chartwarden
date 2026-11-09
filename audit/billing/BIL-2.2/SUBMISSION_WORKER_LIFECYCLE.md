# Submission worker lifecycle

Registered processors: `registerM23DomainWorkers` and `registerM23LaunchWorkers` in `apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts`.

1. **Prepare transaction:** `withOrgContext` loads claim and original queued attempt, checks tenant/provider linkage and submit eligibility, renders with the authoritative M23 renderer, compares the stored reviewed fingerprint, and atomically changes `dispatch_state` from `pending` to `sending` with a random fencing token.
2. **Send:** after the transaction resolves, the worker invokes `macPortalOf(deps).upload`. The existing transport continues to validate route/account/environment and reserve immutable BIL-1 send-time evidence before Claim.MD upload.
3. **Finalize transaction:** a separate `withOrgContext` verifies the fencing token and persists the outcome, claim transition (only if its version remains current), and outbox event. A claim state conflict never overwrites a newer claim state.

The transaction boundary is about database transactions, not an atomic transaction with the external payer. If upload throws after `sending` was committed, the worker records `in_doubt` with a bounded reason code and does not publish an automatic retry. A replay of a `sending`/`in_doubt` attempt consults the existing clearinghouse attempt store; it finalizes only if that store proves a sent receipt. Otherwise it does not send again.

The generated 837I is held in process memory between phases. The reviewed business fingerprint and original attempt are durable; exact final outbound bytes remain governed by the existing immutable BIL-1 evidence reserve. No transaction remains open while `upload` is awaited in the registered worker compositions.

The legacy one-transaction processors are retained only as deprecated direct-test/compatibility exports. Production registration points to the split lifecycle functions; verify no other composition imports the deprecated exports before activation.
