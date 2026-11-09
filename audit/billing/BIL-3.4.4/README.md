# BIL-3.4.4 — Controlled Claim.MD ERA Posting

Implemented a narrow tenant-scoped path from an already staged ERA through immutable M25 posting plan, separate approval, and explicit execution. The path reuses the encrypted stage, BIL-3.2 matching, BIL-3.3 financial review, and BIL-3.4.3 M25 transaction core. It never calls Claim.MD and is disabled by default.

The supported accounting case is deliberately limited to one M41 commercial claim with positive payment exactly equal to charge, zero patient responsibility, and no line-level or adjustment content. Unsupported facts produce blockers.

The private PostgreSQL suite exercises the stage adapter, plan, review, approval, stale-plan refusal, disabled gate, transactional M25 execution, rollback, and concurrent execution using the restricted application role. See [POSTGRESQL_TEST_RESULTS.md](POSTGRESQL_TEST_RESULTS.md) for the run outcome.

Synchronous success means the M25 remittance records and transactional outbox events committed. M23 claim-state and M26 CAP consumers remain downstream asynchronous effects; this does not establish bank settlement or general AR reconciliation.
