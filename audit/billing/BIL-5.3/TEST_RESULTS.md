# Test results

## Executed

- `bun run openapi:check && bun run client:check` — PASS; generated OpenAPI/client are synchronized (1,980 routes reported by the checker).
- `bun run test -- apps/web/src/modules/23-billing-medicare/__tests__/billing-operations.dom.test.tsx` — PASS, 7 tests.
- Targeted `bunx biome check` for the new M25 report/schema/routes, affected UI, DOM test, OpenAPI enrichment and BIL-5.3 docs — PASS, 8 files.
- `bun run arch:tenancy && bun run arch:tables` — PASS.
- `git diff --check` — PASS.
- First private-runner execution of `scripts/test-m25-835-ingestion-private.sh` reached the fresh private PostgreSQL M25 suite: 50 passed, 1 failed. The failure was the new report test fixture: legacy automatic matching did not post that Medicare-seeded fixture. The test now uses the suite's already-tested explicit-association posting fixture and asserts its actual $42.00 source amount.

## Not verified after the correction

The required rerun of the private live suite was refused by the repository's `[chartwarden-harness]` PreToolUse guard. It specifically blocks live suites that drop `chartwarden_app` when Codex cannot confirm the database URL is a private disposable `chartwarden-postgres:dev` container. No alternative command was used to bypass that guard. Therefore the corrected private HTTP/PostgreSQL test is **NOT VERIFIED** and the prior run remains a failure, not a pass.

`bun run typecheck` completed all 13 project-graph source batches, then entered `tsc -p tsconfig.tests.json`; the turn was interrupted while test-source typechecking was still running. Full typecheck is **NOT VERIFIED**. `bun run lint -- ...` invokes repository-wide `biome check .`; it checked 8,949 files and failed on two formatting findings in already-modified BIL-5.2B.1 live-test files. The targeted non-live BIL-5.3 lint passed. These unrelated prior changes were preserved and not autoformatted.

No M41-to-M25 reconciliation test was added or executed. No full M23/M24/M41 claim aggregate is claimed.
