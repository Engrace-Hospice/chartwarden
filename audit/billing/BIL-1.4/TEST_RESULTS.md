# Test results

## Executed

- `bun vitest run packages/x12-837-client/src/clearinghouse/claimmd-account-era.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-routing.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/capture.test.ts` — **15 tests passed across 3 files**.
- `bun vitest run packages/x12-837-client/src/clearinghouse/claimmd-account-era.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-routing.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-capture.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/capture.test.ts` — **17 tests passed across 4 files**.
- `bun run arch:migration-numbering` — passed; 1356 was accepted as a unique migration ordinal.
- `bun run arch:ddl` — passed.
- `bun run arch:tenancy` — passed.
- `bun run arch:migration-compat` — passed; migration 1356 declares `expand`.
- `bun run arch:manifest-mirror` — passed.
- `bun run arch:compliance` — passed.
- `bun run arch:tables` — passed; no cross-module schema access, raw-SQL, or platform-bypass findings.
- `bun run build` — passed.
- `bun run typecheck:tests` — passed.
- `git diff --check` — passed.

No live PostgreSQL/RLS tests, full test suite, Claim.MD calls, services, or production migrations were run. Private PostgreSQL tests must use a dedicated cluster following repository AGENTS.md.

The existing `packages/db/migrations/__tests__/m25-rls-isolation.live.test.ts` was extended with central-inbox privilege and tenant-scoped staging assertions. It remains pending execution against the private PostgreSQL harness; its existing `test:rls:live:m25` script and CI job are reused.
