# Test results

Executed on the BIL-3.1 worktree:

- `bunx vitest run apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-review.test.ts apps/backend/src/modules/25-remittance/routes/__tests__/claimmd-era-review.routes.test.ts apps/web/src/modules/25-remittance/claimmd-era-review.dom.test.tsx` — **3 files, 17 tests passed**.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b apps/backend/tsconfig.json apps/web/tsconfig.json --pretty` — passed. The initial run without the configured heap limit exhausted Node's default heap; the prescribed 8 GB run passed.
- `bun run openapi:emit`, `bun run client:gen`, `bun run openapi:check`, `bun run client:check` — passed; generated detail and list contracts include the history, filter, pagination and duplicate-classification fields.
- `bun run arch:tables`, `bun run arch:tenancy`, `bun run arch:ddl`, `bun run arch:openapi-provenance`, `bun run ui:parity --check`, `bun run docs:ui` — passed.
- `git diff --check` — passed.

No isolated PostgreSQL/RLS test was executed. This phase adds no DDL; mock/API tests do not certify live RLS. No live Claim.MD requests, posting operations, shared/production migrations or worker activation occurred.
