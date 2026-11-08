# Private PostgreSQL harness

`run-private-postgres.sh` is the reusable Phase 1.1 database runner. From any repository directory:

```bash
bash audit/billing/BIL-1-RELEASE-GATE/PHASE-1.1/run-private-postgres.sh
```

It requires Docker, Bun, OpenSSL, and the locally cached `pgvector/pgvector:pg18` image. It starts a uniquely named container on an ephemeral loopback port with `max_locks_per_transaction=1024`, creates a random ephemeral password, exports a test URL only to child test processes, runs database-resetting suites serially, and removes its own container on exit. It never reads or writes the developer's `.env` or `CHARTWARDEN_TEST_DATABASE_URL`; it will not pull an image implicitly.

The script currently runs the reusable M23 response inbox DB/lease suite, M23 tenant RLS, and M25 tenant RLS. That is a **database smoke subset**, not the missing integrated Billing harness. The response test itself replays the repository migration files into a fresh `public` schema and drops canonical test roles. Never point these suites at a shared or application database.

PostgreSQL 18 matches both development compose (`docker-compose.yml:32`) and the production image digest in `deploy/production/compose.yml:23`. Test role authentication is verified by `apps/backend/__tests__/_live-app-role.ts` for suites that use it.

## Cleanup and failure behavior

The EXIT/INT/TERM trap removes only the uniquely named container created by this invocation. It does not delete volumes or databases on another container. A failed suite exits nonzero and cleanup still runs. Results are emitted by Vitest; no credentials are printed.

## Missing harness coverage

The two-tenant response and ERA pipeline suites, independent worker crash/restart suite, and authenticated operator recovery live suite remain unimplemented. Do not describe the present script as satisfying those acceptance criteria.
