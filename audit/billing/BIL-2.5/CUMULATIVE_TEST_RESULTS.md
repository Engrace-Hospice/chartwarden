# Cumulative test results

## Executed and passed

| Command/suite | Result |
|---|---:|
| Focused backend group: M23 preview/loader/submit/context/worker/outbox, M41 gate/ack/worker, M24 submission/route/registry | 12 files, 153 tests passed |
| Focused web DOM group: M23 stale preview/history, M41 detail/timeline, M24 editor-surveyor link | 5 files, 20 tests passed |
| M24 backend injection/route and DOM workbench/assembly | 4 test files, 69 tests passed (route test overlaps the backend group) |
| M23 UI focused group | 4 files, 48 tests passed |
| M23 private PostgreSQL clearinghouse worker lifecycle | 1 file, 17 tests passed; includes retry/source binding and stale redelivery regressions |
| M23 transport failure-classification unit suite | 1 file, 5 tests passed |
| M23 FORCE RLS live suite | 13/13 passed |
| M24 FORCE RLS live suite | 22/22 passed |
| M41 private PostgreSQL claim/correction suite | 1 file, 37 tests passed |
| M41 private PostgreSQL routes | 1 file, 11 tests passed |
| M41 private PostgreSQL submission | 1 file, 88 tests passed, 4 skipped (Valkey/Redis unavailable) |
| M41 claim detail + timeline after the BIL-2.5 submit action | 2 files, 17 tests passed |
| Claim.MD default-disabled/cutover guards (capture, identity, ack, ERA) | 5 files, 13 tests passed |
| Directly affected M23/M24 injection and M41 submission route suites | 3 files, 120 tests passed |
| Backend, DB, web, Medicaid adapter TypeScript build | `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b packages/db/tsconfig.json apps/backend/tsconfig.json apps/web/tsconfig.json packages/medicaid-adapters/tsconfig.json --pretty false` passed |
| Client/OpenAPI | `bun run client:check`, `bun run openapi:check`, `bun run arch:openapi-provenance` passed |
| Migration numbering/compatibility | `bun run arch:migration-numbering`, `bun run arch:migration-compat` passed |
| Architecture | `arch:tables`, `arch:tenancy`, `arch:ddl`, `arch:manifest-mirror`, `arch:migration-numbering`, `arch:migration-compat` passed |
| Integrity | Final `git diff --check` passed; new BIL-2.5 reports have no trailing whitespace |

The group totals intentionally overlap some files and must not be summed into a unique-test count. External transport was mocked; no Claim.MD or state Medicaid request occurred.

## Not run / not certified

- Full monorepo test suite and full E2E suite were not run.
- Production baseline migration/deployment interruption rehearsal was not run.
- Live vendor tests and every payer/state companion-guide route were not run.
- Full M41 suite portions requiring real Valkey/Redis were skipped.
- Full production IdP test for M41 route auth was not part of the private claim test harness.
- The monorepo-wide `bun run typecheck:tests` reached 12 pre-existing/stale fixture typing errors in M23/M24/M41 tests. Those fixture contracts were corrected (M24 no longer accepts client MCO mutation, M23 dispatch/fingerprint/read DTO fixtures are complete, M41 timeline includes lineage). The global check was stopped when memory pressure reached 5.8 GB RSS and nearly exhausted swap. A targeted check of the five affected test files is run separately; see final response. This is not reported as a full test typecheck pass.
- After the source retry corrections, the focused M23 live PostgreSQL clearinghouse suite was rerun to completion: 17/17 passed. The targeted test TypeScript program and affected backend/DB/web/Medicaid adapter build pass; the global test typecheck remains uncompleted due the recorded memory limit.
