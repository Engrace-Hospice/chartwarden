# BIL-1.5A — Runtime & Operational Hardening

## Verdict: NO-GO for BIL-1.5B cumulative certification

This branch adds an authorized, read-only M25 consumer for verified Claim.MD staging, wires BIL-1.1 account-wide response capture behind an explicit opt-in, prevents M23 provider polling from competing while that capture is enabled, and adds an exact-identity financial hold at the M25 posting boundary. All new behavior remains disabled unless its existing independent feature flag is explicitly enabled.

This is source-level implementation evidence, not runtime certification. Audited recovery/requeue, complete operating metrics/readiness, and PostgreSQL-backed financial boundary tests are still missing. M23 NOE/NOTR/transfer submissions still fail closed on the claim-only immutable evidence contract. Do not activate billing workers or production operations.

See [release blockers](RELEASE_BLOCKERS.md), [test results](TEST_RESULTS.md), and [BIL-1.5B handoff](BIL_1_5B_HANDOFF.md).
