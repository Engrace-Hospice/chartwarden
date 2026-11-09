# Test results

- PASS — `bunx vitest run apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts apps/backend/src/modules/23-billing-medicare/__tests__/claim-837i-loader.test.ts apps/backend/src/modules/41-billing-commercial/jobs/submission-worker.test.ts apps/backend/src/modules/41-billing-commercial/services/render-837i.test.ts packages/x12-837-client/src/clearinghouse/submission-evidence.test.ts`: 4 files, 63 tests. (Vitest discovered four files among the supplied paths.)
- PASS — `bunx tsc -p packages/db/tsconfig.json --noEmit --pretty false`.
- PASS — `bunx tsc -p packages/x12-837-client/tsconfig.json --noEmit --pretty false`.
- PASS — `NODE_OPTIONS=--max-old-space-size=6144 bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false`.
- PASS — `bun run arch:tables`, `bun run arch:tenancy`, `bun run arch:ddl`, `bun run arch:migration-numbering`, and `bun run arch:migration-compat`. The repository contains the documented frozen historical ordinal aliases; the gate reported every active ordinal unique.
- PASS — `git diff --check`.
- PASS — `BIL1_TEST_PG_IMAGE=chartwarden-postgres:dev bash audit/billing/BIL-1-RELEASE-GATE/PHASE-1.1/run-private-postgres.sh`: fresh disposable PostgreSQL 18.6; full migrations applied (including 1396); response inbox 3/3, M23 FORCE RLS 14/14 (including line evidence tenant/provider checks, immutability, and audit metadata), M25 FORCE RLS 21/21.
- NOT EXECUTED — posting-plan, approval, concurrency, accounting rollback, duplicate-source, and ledger integration tests.
- NOT EXECUTED — full posting workflow tests, because no controlled posting path was added.
- NOT EXECUTED — live Claim.MD calls, production migrations, worker activation, or financial posting.

No full monorepo suite was run.
