# Test results

Executed for this increment:

- `BIL_TEST_ONLY=m41 scripts/test-m25-835-ingestion-private.sh` — PASS, 15/15 tests, private disposable PostgreSQL; includes full M23 and M41 investigation route lifecycles.
- `bunx vitest run apps/web/src/modules/23-billing-medicare/__tests__/billing-operations.dom.test.tsx` — PASS, 6/6.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false` — PASS.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p apps/web/tsconfig.json --noEmit --pretty false` — PASS.
- Focused `tsc` programs for `m41-commercial-routes.live.test.ts` and `billing-operations.dom.test.tsx` — PASS.
- The repository-wide `bun run typecheck:tests` attempt did not complete in this session; focused TypeScript programs for both changed test files passed.
- `bun run openapi:emit`, `bun run openapi:check`, `bun run client:gen`, `bun run client:check` — PASS; 1,979 routes emitted and client current.
- `bun run arch:tenancy` — PASS; `git diff --check` — PASS.
- `bun run arch:fitness` — complete run before refreshing generated reports: 45/49 gates PASS. It failed on `arch:docling-lock` (`uv` unavailable), `arch:parity` (pre-existing orphans `packages/domain` and `packages/admin-ui-shell`), and stale `status:matrix`/`inject:coverage` reports. Refreshed both reports; `bun run status:matrix --check` and `bun run inject:coverage --check` now PASS. A subsequent aggregate run did not complete, so no post-refresh aggregate result is claimed. The remaining two known blockers are the missing `uv` and manifest orphans.
- `bunx biome check` on the eight changed backend/frontend source and DOM-test files (excluding the live suite) — PASS. The harness refused a direct lint command naming the live-suite file because it requires explicit private-database confirmation; the private runner itself executed successfully. The live test passed focused TypeScript checking.

No production or shared database, external payer, or Claim.MD service was contacted.
