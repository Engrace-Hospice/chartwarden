# BIL-3.2.1 — Historical Claim Identity & Line Matching

This corrective slice adds tenant/provider-scoped historical submission candidate projections for M23 and M41, candidate evidence comparison in the existing M25 matching review, and audited manual selection of a supported claim attempt. A reviewer selection is explicitly labelled human-confirmed, not system-verified.

Service-line decisions remain fail-closed. The 835 parser retains payer `REF*6R` references, but current M23/M41 837 builders and immutable submission evidence do not bind those references to an attempt-specific internal line snapshot. No line association is inferred for old or new submissions by this change.

No posting, allocation, ledger, balance, inbox, or vendor-send operation was added. Migration 1394 remains the decision store; no schema migration was added. The independent FK-index migration moved from ordinal 1378 to 1382 with an exact-checksum filename alias in the migration runner.

See `TEST_RESULTS.md` and `NEXT_PHASE_READINESS.md` for executed evidence and limitations.
