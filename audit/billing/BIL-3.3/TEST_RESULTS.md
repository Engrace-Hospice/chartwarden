# Test results

Results are specific to the current dirty worktree; no prior phase totals are reused.

| Check | Result |
|---|---|
| `bunx vitest run apps/backend/src/modules/25-remittance/domain/__tests__/era-financial-review.test.ts apps/backend/src/modules/25-remittance/routes/__tests__/claimmd-era-review.routes.test.ts apps/web/src/modules/25-remittance/claimmd-era-review.dom.test.tsx` | 21 passed |
| Final focused regression command covering financial projection, match projection, stage review, routes and DOM | 32 passed across 5 files |
| `NODE_OPTIONS=--max-old-space-size=6144 bunx tsc -b apps/backend/tsconfig.json --pretty false` | Passed after fixing projection input types |
| `NODE_OPTIONS=--max-old-space-size=6144 bunx tsc -b apps/web/tsconfig.json --pretty false` | Passed |
| `bun run test:rls:live:m25` on private PostgreSQL 18.6 | 21 passed after adjusting append-only assertions to test app-role privilege denial and trigger denial separately |
| Initial M25 RLS run | 19 passed, 2 assertion failures: app role correctly lacked UPDATE privilege before reaching trigger; assertions now verify both app-role denial and trigger behavior as owner |
| `bun run arch:tables` | Passed after correcting a false-positive import scanner match for a word in route/schema filenames |
| `bun run arch:tenancy`, `bun run arch:ddl` | Passed |
| `bun run arch:migration-numbering`, `bun run arch:migration-compat` | Passed; ordinal 1395 unique and expand-compatible |
| `bun run arch:openapi-provenance`, `bun run openapi:check`, `bun run client:check` | Passed |
| `git diff --check && git diff --cached --check` | Passed |
| `DATABASE_ADMIN_URL=<private PG18 DB> bun run db:migrate:deploy` | 673 migrations applied on fresh disposable DB, including 1394/1395 |
| `bun run scripts/db/migrate.ts --strict --strict-orphans --schema-only` after simulating the old 1378 ledger filename with matching checksum | Adopted as 1382; 673 already applied, zero pending; no duplicate execution |
| Same runner after simulating legacy filename with incorrect checksum | Failed closed on strict orphan check; no migrations ran; ledger stayed unchanged |

The final focused command was:

```sh
bunx vitest run \
  apps/backend/src/modules/25-remittance/domain/__tests__/era-financial-review.test.ts \
  apps/backend/src/modules/25-remittance/domain/__tests__/era-match-review.test.ts \
  apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-review.test.ts \
  apps/backend/src/modules/25-remittance/routes/__tests__/claimmd-era-review.routes.test.ts \
  apps/web/src/modules/25-remittance/claimmd-era-review.dom.test.tsx
```

It passed **32 tests across 5 files**. Backend and web project TypeScript checks also passed. The RLS suite used a real `chartwarden_app` application role (`rolbypassrls=false`) and synthetic organizations. The M25 API persistence method was not invoked end-to-end against PostgreSQL: route tests use a service spy, while the live suite directly validated the decision table, RLS, tenant denial and append-only constraints. No live Claim.MD calls, production migrations, or posting actions occurred.
