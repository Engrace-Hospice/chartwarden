# Test results

Focused checks run against the current dirty worktree; these are not a claim that unrelated BIL-5.1/5.2A changes are committed.

- `BIL_TEST_ONLY=m41 scripts/test-m25-835-ingestion-private.sh` — passed, 14/14 tests, using a fresh private PostgreSQL container and `chartwarden_app`; includes source-owner M41 resolution, M25 investigation create/list/detail, denied permissions, provider denial, and guessed foreign-tenant detail returning not found.
- `BIL_TEST_ONLY=m23 scripts/test-m25-835-ingestion-private.sh` — passed, 6/6 tests, using a fresh private PostgreSQL container; exercises the M23 source-owned reader including older attempts beyond ordinary claim-list coverage.
- `bunx vitest run apps/web/src/modules/23-billing-medicare/__tests__/billing-operations.dom.test.tsx` — passed, 5/5 tests.
- `bun run openapi:check` — passed, 1,979 routes emitted and enriched.
- `bun run client:check` — passed; generated schema matches `docs/api/openapi.json`.
- `bun run arch:migration-numbering` — passed on the current local migration inventory; ordinal 1454 is unique locally.
- `bunx biome check <10 changed TS/TSX files>` — passed after formatting.
- `git diff --check` — passed.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false` — passed.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p apps/web/tsconfig.json --noEmit --pretty false` — passed.
- `bun run arch:tenancy` — passed: canonical organization RLS and FORCE checks.
- `bun run arch:migration-compat` — passed: migration compatibility declarations valid.
- `bun run arch:fitness` — initial run: 43/49 gates passed; 6 failed (missing `uv`, two existing manifest orphans, and four stale generated reports). The four reports were regenerated, then their individual status-matrix, E2E-coverage, OpenAPI-coverage, and inject-coverage `--check` commands all passed. The full fitness command was not rerun after regeneration, so the aggregate final result is not claimed.
- No production/shared database or live clearinghouse was used.
