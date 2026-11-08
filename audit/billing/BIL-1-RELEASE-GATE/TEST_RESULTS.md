# BIL-1 Release Gate Phase 1 — test results

## Phase 1 execution

| Command / exercise | Result | Notes |
|---|---|---|
| `bunx vitest run apps/backend/src/bootstrap/routes/__tests__/ops-claimmd-era-recovery.test.ts apps/backend/src/bootstrap/__tests__/claimmd-operational-metrics.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-recovery.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-delivery.test.ts packages/x12-837-client/src/clearinghouse/notice-submission-evidence.test.ts scripts/__tests__/deploy-schema-rollback.test.ts scripts/__tests__/check-migration-compat.test.ts` | PASS, 7 files / 92 tests | Authorization, recovery, delivery, metrics, notice evidence, deploy rollback and compatibility. |
| `CHARTWARDEN_TEST_DATABASE_URL=<private-loopback-PG18> bun run test:db:migrate:live` | PASS, 1 file / 13 tests | Actual repository migration runner, fresh replay, no-op, checksum and ledger behavior. |
| Populated upgrade via `applyMigrations()` strict mode | PASS | 642 migrations below 1350, synthetic org/provider/location, M23/M41/M25 seed, then 1350–1361. Counts unchanged. The temporary seed driver was under `/tmp` and is not committed. |
| Migration transaction interruption/restart exercise | PASS | Partial second DDL rolled back; prior migration remained; corrected rerun applied once; following run no-op. Temporary runner script under `/tmp`, not committed. |
| `CHARTWARDEN_TEST_DATABASE_URL=<private-loopback-PG18> bunx vitest run packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts` | PASS, 13/13 | Real application role, private DB. |
| `CHARTWARDEN_TEST_DATABASE_URL=<private-loopback-PG18> bunx vitest run packages/db/migrations/__tests__/m25-rls-isolation.live.test.ts` | PASS, 16/16 | Run serially, real application role. |
| Full build / test typecheck / cumulative M23-M25-M41 suite | PASS in BIL-1.5B | Build 14 batches; test typecheck exit 0; 161 files, 1,992 passed, 12 skipped. See prior phase report. Not rerun after documentation-only Phase 1 changes. |
| `git diff --cached --check`, commit pre-hook PHI scan | PASS | Hook reported Gitleaks unavailable and skipped. |

## Failed attempts and corrections

- A first populated-upgrade fixture lacked an active synthetic M40 commercial payer; the M41 plan guard correctly rejected the seed. The fixture was corrected with an active synthetic payer.
- A subsequent report query referenced nonexistent `claimmd_response_inbox`; actual schema is stream/batch/event. Query corrected; final upgrade completed and preserved counts.
- The two RLS suites were initially started together against one test cluster. They both reset `public`, producing a schema collision; M23 passed and M25 was rerun alone and passed 16/16. Do not run destructive live suites concurrently on one cluster.
- One earlier baseline attempt reused a temporary cluster with roles from a previous run; it was discarded and the certification rerun on a fresh private container.

## Not run

Integrated two-tenant response/ERA journey, two-process lease/fencing and crash replay, full authenticated recovery route plus PostgreSQL audit, in-place `deploy.sh` failure/restart, production-shaped backup/restore, branch CI, formal PR/security approval, and Claim.MD test-account calls. These are not passes.
