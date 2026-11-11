# Remaining blockers

1. **Database contract validation — P1 before activation:** migration 1378, its enum append, attempt terminalization trigger, and immutable fingerprint persistence require isolated PostgreSQL execution under the real application role.
2. **Transaction duration — P1 before activation:** the registered worker still wraps `runClaimSubmit` in `withOrgContext`; the transaction scope spans external upload. Refactor to fenced prepare/send/finalize phases and prove crash/retry idempotency before controlled activation.
3. **Concurrency certification — P1 before activation:** test dependent-source updates around reservation/send, duplicate outbox processing, and retries after uncertain completion. The database and network operation cannot be atomic.
4. **Legacy fallback — P1 for incomplete worker compositions:** standard composition now renders through the shared loader and transmits those bytes through the legacy MAC port. A composition missing loader/context cannot verify a new reviewed attempt and will fail closed; certify that the production worker always binds them.
5. **Frontend behavior suite — P2:** the stale-source history presentation test passes; add claim-editor component tests for expiry, refresh, token invalidation after edits, and stale-submit feedback.
6. **Signing-key operations:** provision a high-entropy shared `CLAIM_PREVIEW_INTEGRITY_KEY`; rotation while jobs are queued intentionally causes a safe hold and requires an operational drain/review plan.

No Claim.MD request, worker activation, or production/controlled-test activation is authorized by this phase.
