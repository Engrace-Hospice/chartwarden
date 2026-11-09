# Test results

Status is updated after focused verification. Do not infer PostgreSQL atomicity from unit tests or TypeScript compilation.

| Check | Result | Evidence |
|---|---|---|
| Backend TypeScript project build | PASS | `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b apps/backend/tsconfig.json --pretty false` |
| Frontend TypeScript project build | PASS | `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b apps/web/tsconfig.json --pretty false` |
| Focused preview, transport, history DOM tests | PASS — 13 tests | `bunx vitest run apps/web/src/modules/23-billing-medicare/__tests__/claim-submission-stale-preview.dom.test.tsx apps/web/src/modules/23-billing-medicare/__tests__/claim-history.dom.test.tsx apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts apps/backend/src/modules/23-billing-medicare/__tests__/claim-preview-integrity.test.ts` |
| M23 live claim submit worker | PASS — 5/5 against private PostgreSQL 18 | `CHARTWARDEN_TEST_DATABASE_URL=<ephemeral-private-url> bunx vitest run apps/backend/__tests__/m23-claim-submit-worker.live.test.ts`; includes real migration application, concurrent worker-function reservation, uncertain send replay, no open idle transaction during transport, submit guard and retry |
| Table ownership, tenancy, DDL | PASS | `bun run arch:tables`; `bun run arch:tenancy`; `bun run arch:ddl` |
| Migration compatibility and numbering | PASS | `bun run arch:migration-compat`; `bun run arch:migration-numbering` |
| OpenAPI and client | PASS | `bun run openapi:check`; `bun run client:check`; `bun run arch:openapi-provenance` |
| `git diff --check` | PASS at last check; rerun after final report edits | `git diff --check` |

The `.env` URL was not used: it was not proven to be on an isolated cluster. The repository's production PostgreSQL image was built and run as a private ephemeral container on its own port, with `max_locks_per_transaction=1024`; the test suite reset schema/roles only inside that container. The container was removed after the passing run. No test used shared `os-postgres-1`, the local app DB, real patient data, or vendor credentials.

The PostgreSQL test calls the real lifecycle from two concurrent invocations and the pool provides separate DB transactions. It is not a separate operating-system process test; process-crash and multi-process certification remain for the cumulative validation phase.
