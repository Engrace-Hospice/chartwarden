# Test Results

## Executed

- `bunx vitest run apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-recovery.test.ts apps/backend/src/modules/25-remittance/routes/__tests__/claimmd-era-review.routes.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-review.test.ts apps/backend/src/bootstrap/__tests__/claimmd-operational-metrics.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/config.test.ts` — **5 files passed, 13 tests passed**.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b apps/backend --pretty false` — passed after building the referenced database package.
- `bun run arch:tables` — passed: no cross-module schema access, raw-SQL, or platform-bypass evasion.
- `bun run arch:tenancy` — passed.
- `bun run arch:ddl` — passed.
- `bun run arch:migration-compat` — passed; migration 1360 is `expand`.
- `bun run arch:migration-numbering` — passed; no ordinal collision.
- `bun run arch:manifest-mirror` — passed.
- `git diff --check` — passed at the time of the gate run; rerun after final documentation edits.

## Added but deferred

- `apps/backend/__tests__/m25-835-ingestion.live.test.ts` adds real PostgreSQL concurrency, independent intake-record, and missing-TRN cases. It was **not run** because `CHARTWARDEN_TEST_DATABASE_URL` is absent. The harness drops/recreates `public` and removes test roles; it must only run against a private disposable database, never `os-postgres-1`.
- Full monorepo build, all tests and global test typecheck were not run under the incremental validation policy.
- No migrations were applied to a database; no Claim.MD API calls or worker activation occurred.
