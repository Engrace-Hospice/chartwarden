# BIL-3.5 handoff

BIL-3.5 cannot certify an integrated Claim.MD-to-ledger flow until the blocking M25 transaction boundary is corrected. Implement a plan-bound M25 operation that consumes a staged ERA and its reviewed claim association, binds plan/approval/source revisions and reuses existing ledger writes in one transaction. Add the API/UI and actual PostgreSQL posting, idempotency, concurrency, rollback, RLS and cross-source duplicate tests. Keep the new capability off by default.
