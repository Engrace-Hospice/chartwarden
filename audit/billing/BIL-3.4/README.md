# BIL-3.4 — Controlled ERA posting and immutable line evidence

## Result

This phase is **partial / NO-GO for posting**. It adds a fail-closed, attempt-specific line-evidence foundation at the Claim.MD immutable submission boundary for M23 and M41. It does not implement or enable a Claim.MD posting plan, separate posting approval, ledger execution, reversals, or posting UX.

The existing M25 `postAdvice` path is financially consequential and is activated by the manual/SFTP `m25.edi.835_received` outbox flow. Claim.MD staging is separate. No safe bridge currently binds the BIL-3.3 match/review decisions and a versioned posting approval to that ledger service. Routing staged files through `receiveAdvice` would therefore be unsafe.

## Implemented

- Parses service-line facts and only an actually transmitted `REF*6R` from the exact outbound 837 bytes.
- Persists M23/M41 internal line identity alongside the existing immutable attempt evidence when the owning renderer supplies line identities.
- Verifies line count, position, and business facts against parsed outbound bytes; conflicting replay fails closed.
- Leaves old attempts without immutable line evidence unavailable; no historical backfill is attempted.
- Does not alter posting flags or invoke M25 posting from ERA staging/review.

## Verification

Focused renderer/submission tests: 4 files, 63 tests passed. Backend, DB, and X12-client typechecks and architecture/migration checks passed. A fresh PostgreSQL 18.6 container applied migrations and the M23/M25 live RLS suites passed, including line-evidence tenant visibility checks. Posting/accounting runtime certification remains unexecuted. See `TEST_RESULTS.md`.

## Next step

First implement a source-bound M25 posting-plan/approval contract that consumes BIL-3.3 matching decisions and is enforced inside the existing ledger transaction. Do not activate it until private PostgreSQL tests establish atomicity, RLS, idempotency, and duplicate-effect safety.
