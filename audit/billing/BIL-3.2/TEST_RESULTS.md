# Test results

Results on the current worktree; commands run after the BIL-3.2 changes:

- `bun run openapi:emit && bun run client:gen` — PASS; OpenAPI emitted 1,963 routes (1,962 enriched) and generated `packages/ui/src/core/api/schema.ts`.
- `bunx vitest run apps/backend/src/modules/25-remittance/domain/__tests__/era-match-review.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-review.test.ts apps/backend/src/modules/25-remittance/routes/__tests__/claimmd-era-review.routes.test.ts apps/web/src/modules/25-remittance/claimmd-era-review.dom.test.tsx` — PASS, 4 files / 23 tests.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b apps/backend/tsconfig.json apps/web/tsconfig.json --pretty` — PASS after fixing the idempotency-helper narrowing and Drizzle stage-export name diagnostics.
- `bun run arch:tables`, `bun run arch:tenancy`, `bun run arch:ddl`, `bun run arch:migration-compat`, `bun run arch:openapi-provenance`, `bun run arch:abac-composed`, `bun run ui:parity -- --check`, and `git diff --check` — PASS.
- `bun run arch:migration-numbering` — FAIL due to an existing duplicate ordinal `1378` between `1378_fk_supporting_indexes_code_status_emergency_recipient.sql` and `1378_m23_claim_reviewed_source_fingerprint.sql`. The new BIL-3.2 migration is 1394; no existing migration was renumbered.
- `packages/db/migrations/__tests__/m25-rls-isolation.live.test.ts` — NOT EXECUTED; unsafe shared local database target, details in [POSTGRESQL_AND_RLS.md](./POSTGRESQL_AND_RLS.md).
- No live Claim.MD calls, production migrations, worker activation, or financial posting were run.

Only the unit/route/UI tests above are mocked/application-level evidence; they do not certify PostgreSQL atomicity or RLS.
