# Test results

## Executed in BIL-1.5A.3

| Command | Result |
|---|---|
| `bunx vitest run apps/backend/src/bootstrap/routes/__tests__/ops-claimmd-era-recovery.test.ts apps/backend/src/bootstrap/__tests__/claimmd-operational-metrics.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-recovery.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/config.test.ts` | PASS — 4 files, 12 tests. |
| `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b apps/backend/tsconfig.json --pretty` | PASS. |
| `bun run arch:tables` | PASS — no cross-module schema access, raw-SQL, or platform-bypass evasion. |
| `bun run arch:tenancy` | PASS. |
| `bun run arch:ddl` | PASS. |
| `bun run arch:migration-compat` | PASS — migrations declare valid compatibility. |
| `bun run arch:migration-numbering` | PASS — unique ordinals; repository reports historical gaps as informational. |
| `bun run arch:manifest-mirror` | PASS. |
| `bun run arch:route-reachability` | PASS — route registrars are reachable from composition root. |
| `bun run arch:abac-predicates` | PASS — every composed ABAC predicate is declared. |
| `bun run arch:test-typecheck` | PASS — all test files are included in a typecheck program. |
| `git diff --check` | PASS. |

The focused tests cover actual route guard composition/invocation via Fastify injection, account/reason validation, metric aggregation labels/failure behavior, existing recovery service behavior, and M23 legacy polling exclusion. They do not prove PostgreSQL RLS, transaction locking, runtime role grants, multi-process fencing, or live readiness against actual services.

## Deferred to BIL-1.5B

Full relevant billing tests, full backend build/test typecheck, private PostgreSQL migrations and `chartwarden_app` RLS tests, cross-worker recovery races, metric queries against indexed production-like data, worker restart/fencing, synthetic end-to-end scenarios and approved Claim.MD test-account certification. No database-backed tests, live API calls, migrations or deployment were run here.
