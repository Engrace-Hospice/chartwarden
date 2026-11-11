# BIL-3.4 handoff

Before controlled financial posting work:

1. Complete immutable send-time line identity capture in M23/M41 and validate returned 835 line-reference namespace against the original attempt.
2. Build a separately authorized posting model and balanced journal semantics with explicit payer/provider rules, approvals, idempotency and reversal/recoupment treatment.
3. Prove database constraints, RLS, concurrency, duplicate financial-effect behavior, and ledger/balance invariants on isolated PostgreSQL with real application roles.
4. Keep this nonposting review decision distinct from any posting authorization.

Do not convert `completed` reviewer disposition into permission or an event for posting.
