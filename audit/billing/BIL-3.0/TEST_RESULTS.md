# BIL-3.0 Focused Test Results

## Executed

- `bunx vitest run --passWithNoTests apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-review.test.ts apps/backend/src/modules/25-remittance/routes/__tests__/claimmd-era-review.routes.test.ts apps/web/src/modules/25-remittance/claimmd-era-review.dom.test.tsx` — **PASS**, final run 3 files / 11 tests (includes retry after a network error).
- `bun run openapi:emit` — **PASS**; generated OpenAPI includes the list summary and detail contracts.
- `bun run client:gen` — **PASS**.
- `bun run openapi:check` — **PASS**, 1,961 routes / 1,960 enriched.
- `bun run client:check` — **PASS**.
- `bun run arch:tenancy`, `bun run arch:ddl`, `bun run arch:tables`, `bun run arch:openapi-provenance` — **PASS**.
- `bun run ui:parity`, `bun run docs:ui`, `bun run arch:ui-parity` — **PASS**; screen corpus and generated parity report agree.
- Scoped `bunx biome check` over affected TypeScript/TSX files — **PASS** after formatting and accessibility/key fixes.
- `git diff --check` — **PASS**.

## In progress / not certified

- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b apps/backend/tsconfig.json apps/web/tsconfig.json --pretty false` — **PASS** on the final backend/web source. The first run surfaced four UI/type-fixture errors; these were fixed, and the final rerun completed with exit code 0.
- PostgreSQL/RLS integration — **NOT RUN**. No private disposable database was established for this phase; mocks do not certify RLS or transaction behavior. No migration was added.
- Full M25 suite and monorepo suite — **NOT RUN**, outside this focused vertical slice.
- Live Claim.MD requests, worker activation, posting, production migration and deployment — **NOT RUN**.

The focused tests verify list summary privacy, review projection, route authorization/scope and the nonposting UI states. They do not establish line-level financial matching or posting correctness.
