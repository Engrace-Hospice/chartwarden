# Test results

Execution environment: private disposable `pgvector/pgvector:pg18`, database `wardenx_phase11_test`, `max_locks_per_transaction=1024`. The first targeted checks used `127.0.0.1:55433`; the reusable runner used an ephemeral loopback port. Both containers were separate from `os-postgres-1` and the local application DB and were removed after execution.

| Test | Result |
|---|---|
| `apps/backend/__tests__/m23-claimmd-response-inbox.live.test.ts` | PASS, 1 file / 3 tests, 13.87 s direct run; 14.27 s in harness. |
| `packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts` | PASS, 1 file / 13 tests, 24.42 s in harness. |
| `packages/db/migrations/__tests__/m25-rls-isolation.live.test.ts` | PASS, 1 file / 16 tests, 24.41 s in harness; earlier direct run also passed 16 tests. |
| `bash audit/billing/BIL-1-RELEASE-GATE/PHASE-1.1/run-private-postgres.sh` | PASS; all 3 suites serialized, 32 tests total. |
| `bunx vitest run apps/backend/src/bootstrap/routes/__tests__/ops-claimmd-era-recovery.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-recovery.test.ts` | PASS, 2 files / 8 tests, 7.56 s. These are route/service unit tests; the route injects a synthetic context and mocked recovery service, so they do not certify real auth or persistence. |
| Integrated two-tenant response / ERA | BLOCKED; no integrated live test present/executed. |
| Independent multi-process/crash recovery | BLOCKED; not exercised. |
| Actual auth plugin → operator recovery route → DB | BLOCKED; existing route test is synthetic/mocked. |
| Deployment script interruption rehearsal | BLOCKED; only prior runner-level migration rollback/restart exists. |
| Focused unit regressions, TypeScript, architecture gates | NOT RUN in Phase 1.1; no source code changed. |
| `bash -n audit/billing/BIL-1-RELEASE-GATE/PHASE-1.1/run-private-postgres.sh` | PASS. |
| `git diff --check` | PASS for tracked diff; `rg -n '[[:blank:]]+$' audit/billing/BIL-1-RELEASE-GATE/PHASE-1.1` found no trailing whitespace in new files. |

No complete billing suite, global build, E2E suite, live Claim.MD request, or production migration was run.
