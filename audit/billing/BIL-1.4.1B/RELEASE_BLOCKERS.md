# Release blockers

## Implementation issues

- **M25 review consumer/UI not established:** staging rows and encrypted details are persisted, but this phase does not prove that an authorized M25 work queue decrypts and presents them for matching/review. Do not enable billing staff workflow until a safe consumer exists.
- **No audited requeue operation:** automatic prepare retries stop after 10 attempts. Held/retry-exhausted records need a bounded internal operation with authorization, reason, and append-only audit history before activation.
- **Operational metrics are partial:** the worker emits aggregate examined/delivered/duplicate/held/failed counts only. Separate PHI-safe age, stale-resolution, cross-tenant conflict, retry, and oldest-undelivered signals plus alert thresholds are not implemented.
- **Cross-source financial idempotency is incomplete:** duplicate checks cover available M25 advice identity fields and conservatively hold weak candidates; they do not establish global posting uniqueness across every manual/SFTP/other source and legacy posting path.

## Runtime certification blockers

- Run DB-backed staging/receipt/replay/crash/concurrency tests on isolated private PostgreSQL as a NOBYPASSRLS application role and approved platform role. Do not use the shared Docker cluster.
- Run M25 live RLS isolation tests including the new central tables, tenant A/B stage separation, `claimmd_capture` grant scope, FORCE RLS, and platform audit evidence.
- Validate multi-worker shared account behavior, rate/cutover operations, key rotation/readability, recovery after database timeout, and migration deployment order. Migration 1358 is `contract`; deploy tooling may halt for operator sequencing/rollback.
- Validate X12 preservation and parser behavior for PLB, negative/recoupment/reversal, zero-pay, partial payments, multiple CLP/SVC, and unsupported segments with synthetic files.

## Activation

All delivery flags remain off unless explicitly enabled. Before controlled tests, require isolated synthetic tenants/provider identities, private DB certification, no posting consumer path, operator-approved account/environment, and a tested rollback/recovery plan. Production additionally requires Claim.MD account configuration, payer readiness, contract/cost confirmation, security review, staged cutover, and BIL-1.5 approval. No live or production credentials were inspected or used in this implementation.
