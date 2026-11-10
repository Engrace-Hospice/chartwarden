# Test results

Executed on the current dirty `develop` worktree:

- `bunx vitest run scripts/__tests__/migrate-orphans.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/historical-match-candidate.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-review.test.ts apps/backend/src/modules/25-remittance/routes/__tests__/claimmd-era-review.routes.test.ts apps/web/src/modules/25-remittance/claimmd-era-review.dom.test.tsx` — PASS, 5 files / 30 tests (23 backend/script, 7 DOM).
- The candidate route initially lacked its response schema in OpenAPI; added the route enrichment, reran `bun run openapi:emit` and `bun run client:gen`, and `bun run client:check` — PASS.
- `bunx tsc -b apps/backend/tsconfig.json --pretty false` — PASS after final reader changes.
- `bun run arch:migration-numbering` — PASS; all current migration ordinals unique, including 1382.
- `bun run arch:migration-compat` — PASS.
- `bun run arch:tenancy` — PASS.
- `bun run arch:ddl` — PASS.
- `bun run arch:tables` — initial run found and drove correction of an M41-to-M23 table ownership violation; final run PASS (no cross-module schema access, raw-SQL, or platform-bypass evasion).
- `git diff --check` — PASS.
- `bunx tsc -b apps/web/tsconfig.json --pretty false` — default 2 GB heap failed; `NODE_OPTIONS=--max-old-space-size=6144 bunx tsc -b apps/web/tsconfig.json --pretty false` — PASS against the corrected generated contract.

Private PostgreSQL/RLS and joined M23/M41 source-reader integration remain NOT EXECUTED. No live vendor or database operation was performed. Full architecture fitness and UI parity were not run.
