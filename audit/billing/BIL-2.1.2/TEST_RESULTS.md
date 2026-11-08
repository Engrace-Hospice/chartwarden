# Test results

Executed locally on branch `develop`, Node/Bun workspace; no Claim.MD calls, claim submissions, workers against configured accounts, or migrations against any database.

## PASS

- `bunx vitest run apps/backend/src/modules/23-billing-medicare/__tests__/claim-preview-integrity.test.ts apps/backend/src/modules/23-billing-medicare/__tests__/claim-837i-loader.test.ts apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts apps/backend/src/modules/23-billing-medicare/outbox-consumers/submit-requests.test.ts apps/backend/__tests__/billing-medicare-inject.test.ts` — 5 files, 113 tests passed.
- `bunx vitest run apps/web/src/modules/23-billing-medicare/__tests__/claim-submission-stale-preview.dom.test.tsx` — 1 file, 1 test passed.
- `bunx tsc -b packages/db packages/billing --pretty false` — passed.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false` — passed.
- `bun run openapi:emit && bun run client:gen && bun run openapi:check && bun run client:check` — generation and consistency checks passed (1,927 routes; 1,924 enriched).
- `bun run arch:tables`, `bun run arch:tenancy`, `bun run arch:ddl`, `bun run arch:migration-compat`, `bun run arch:migration-numbering`, `bun run arch:openapi-provenance`, `bun run arch:route-reachability` — passed.
- `bun run arch:test-typecheck` — all 2,580 test files across two Vitest projects are in a typecheck program.
- `git diff --check` — passed after final source and documentation edits.

## FAIL / LIMITATION

- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p apps/web/tsconfig.json --noEmit --pretty false` — fails in pre-existing M16 Bereavement API/client files (missing generated operation properties, excessive generic depth, and implicit-any fallout). No diagnostic referenced the changed M23 claim editor or submission timeline. The new focused web DOM test passed.

## NOT RUN

- PostgreSQL migration/trigger/append-only persistence tests and RLS verification. Migration 1378 is source-checked only; it was not applied.
- Frontend claim-editor interaction suite for expiry, refresh, token invalidation and submission error states. The repo now has a focused stale-source history presentation test; broader component coverage remains.
- Full M23/BIL-2 tests, global build, full E2E, Claim.MD sandbox or production calls.

Mocks verify route and worker decisions; they do not prove PostgreSQL concurrency, trigger behavior or RLS.
