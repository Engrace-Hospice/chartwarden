# Test results

## Executed

- `bunx vitest run packages/medicaid-adapters/__tests__/registry.test.ts apps/backend/__tests__/m24-route-validation.test.ts apps/backend/__tests__/env-validation.test.ts apps/backend/__tests__/billing-medicaid-inject.test.ts apps/web/src/modules/24-billing-medicaid/claim-editor-surveyor-link.dom.test.tsx` — **PASS**, 5 files / 132 tests.
- `bunx vitest run apps/backend/src/modules/24-billing-medicaid/jobs/submission-jobs.test.ts` — **PASS**, 1 file / 1 worker-poll safety test.
- `bun run openapi:emit` — **PASS**, 1,928 routes / 1,925 enriched (the generated OpenAPI was refreshed).
- `bun run client:gen` — **PASS**.
- `bun run client:check && bun run openapi:check && bun run arch:openapi-provenance` — **PASS**; provenance reports 2,755/2,856 route/schema pairs attributable, 101 documented non-placeable pairs, no duplicate aliases, all 1,925 route keys unique.
- `bun run arch:tenancy && bun run arch:ddl` — **PASS**.
- `bun run arch:test-typecheck` — **PASS**, all 2,580 test files were represented by test typecheck programs.
- `bun run arch:tables` — **PASS**: no cross-module schema access, raw-SQL, or platform-bypass violation.
- `bun run arch:migration-numbering && bun run arch:migration-compat` — **PASS** (no BIL-2.4 migration was added).
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b apps/backend apps/web packages/medicaid-adapters --pretty false` — **PASS**. The first pass exposed literal widening in `requestedChannel`; explicit literal typing fixed it, and the rerun passed.
- `git diff --check` — **PASS**; untracked BIL-2.4 markdown trailing whitespace check — **PASS**.

## Not run / deferred

- The schema-resetting PostgreSQL live suites were not run. They drop `public` and cluster-level test roles, and a disposable private target required by repository safety policy was not independently verified. No BIL-2.4 migration or RLS change was made; DB runtime certification remains deferred to cumulative validation.
- Broader monorepo tests, global build/E2E, and live state payer calls were not run.

No state payer transaction or live Claim.MD call was made. No database migration was executed.
