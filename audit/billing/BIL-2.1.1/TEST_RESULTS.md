# Test results

## Executed

- `bunx vitest run apps/backend/src/modules/23-billing-medicare/__tests__/claim-837i-loader.test.ts` — PASS, 1 file / 34 tests.
- `bunx vitest run apps/backend/__tests__/billing-medicare-inject.test.ts apps/backend/src/modules/23-billing-medicare/__tests__/claim-837i-loader.test.ts` — PASS, 2 files / 92 tests (includes preparation route authorization/projection and renderer-hook tests).
- `bunx vitest run apps/backend/src/modules/23-billing-medicare/__tests__/claim-837i-loader.test.ts apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.test.ts apps/backend/src/modules/23-billing-medicare/outbox-consumers/submit-requests.test.ts apps/backend/__tests__/billing-medicare-inject.test.ts` — PASS, 4 files / 106 tests.
- `bun run openapi:emit` — PASS; regenerated `docs/api/openapi.json`.
- `bun run client:gen` — PASS; regenerated `packages/ui/src/core/api/schema.ts`.
- `git diff --check` — PASS at last check before final edits; rerun required.

## Incomplete / not run

- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false` — PASS, exit 0. (A prior project-reference build attempt was interrupted; the direct backend check completed successfully.)
- Dedicated frontend behavior tests: NOT RUN.
- Architecture/tenancy checks: NOT RUN.
- Full web typecheck: NOT RUN (previous BIL-2.1 report documents unrelated M16 generated-client errors).
- No PostgreSQL, live Claim.MD, payer, migration, or worker execution.

The HTTP inject suite proves route-level permission denial and invokes the injected renderer contract; the boot-level Drizzle renderer composition has not been exercised against PostgreSQL. Stale-source coverage remains uncertified.
