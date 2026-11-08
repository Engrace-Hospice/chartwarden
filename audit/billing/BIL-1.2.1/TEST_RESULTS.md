# Test results

## Executed in this phase

```sh
bunx vitest run apps/backend/src/modules/23-billing-medicare/claimmd-identity/resolve.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-identity/service.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-identity/event-identifiers.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/capture.test.ts packages/x12-837-client/src/clearinghouse/claimmd-account-response.test.ts
```

Result: **5 test files passed; 16 tests passed**. These are existing focused offline tests, not new BIL-1.2.1 tests. No source code or test files were changed.

No build, typecheck, full test suite, live database test, migration application, test-account transaction, Claim.MD API call, or production action was performed in this phase. `pg_isready` reported the shared local Postgres accepts connections, and Docker identifies it as `os-postgres-1`; repository policy prohibits running live suites against that shared cluster.

## Commands to run in the corrective implementation PR

- Focused new unit tests for evidence extraction, fail-closed send reservation, receipt namespace and candidate adapter.
- `bun run build` and `bun run typecheck`.
- Targeted architecture gates: tenancy, table ownership, manifest mirror, migration numbering/compatibility/DDL legality, route reachability, ABAC where applicable.
- New live suite against a private disposable PostgreSQL cluster with `chartwarden_app` as NOBYPASSRLS and dedicated platform role; add package script and CI job per `AGENTS.md`.

Do not run `bun run test` or a shared-cluster live suite as part of this report-only turn.
