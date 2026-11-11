# PostgreSQL, HTTP, and RLS tests

Command:

`BIL_TEST_ONLY=claimmd-ops bash scripts/test-m25-835-ingestion-private.sh`

Result: **PASS, 4/4** on a fresh disposable `chartwarden-postgres:dev` container.

Coverage includes real provisioned platform role, Fastify permission/ABAC/role guards, M23/M25 durable readers, bounded central response, tenant PostgreSQL denial, environment mismatch, recovery eligibility, two concurrent dry-runs, and durable-state nonmutation.

The run emitted a `pg` deprecation warning during migration setup; it did not affect assertions.
