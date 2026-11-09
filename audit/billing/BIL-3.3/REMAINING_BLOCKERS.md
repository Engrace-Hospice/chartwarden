# Remaining blockers

1. **Service-line financial allocation — high, source evidence dependency:** M23/M41 currently do not persist an authoritative attempt-specific mapping from original outbound line reference to internal claim-line identity. Continue to show ERA line detail without claiming a WardenX line match. Implement source-owned immutable line snapshots at send time before any line allocation.
2. **Posting certification — high, future scope:** no posting, payment allocation, bank reconciliation, AR mutation, reversal, or recoupment is implemented or authorized by this phase.
3. **Operational activation — external:** Claim.MD worker enablement and live payer/vendor certification remain separately gated.
4. **Historical display name — low:** reviewer membership ID is retained; user-name lookup is not part of this phase.

Private PostgreSQL 18.6 RLS and migration-runner validation passed as recorded in `TEST_RESULTS.md`. Concurrent invocation of the backend financial-review service against PostgreSQL was not separately exercised; the live suite proves table/RLS/immutability constraints, while route tests use the real authorization guard with a service spy.
