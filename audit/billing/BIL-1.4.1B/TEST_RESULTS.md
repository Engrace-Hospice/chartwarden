# Test results

## Executed

Focused command:

```bash
bun vitest run apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-delivery.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-duplicate.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-legacy-stage-guard.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-resolution.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-routing.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-capture.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/payee-check.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/payee-tin.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/production-day.test.ts packages/x12-835-client/__tests__/parse-x12-835.test.ts packages/x12-835-client/__tests__/parse-x12-835-hardening.test.ts packages/x12-835-client/__tests__/parse-x12-835-671.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/capture.test.ts
```

**13 files, 111 tests passed.**

```bash
NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -b apps/backend packages/db --pretty
```

**Passed (exit 0).**

```bash
NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck:tests
```

**Passed (exit 0).**

Architecture/schema checks:

- `bun run arch:tenancy` — passed.
- `bun run arch:ddl` — passed.
- `bun run arch:migration-compat` — passed after migration 1358 was classified `contract` because the gate identifies `ADD CONSTRAINT` as potentially contracting.
- `bun run arch:migration-numbering` — passed; reports repository's historical gaps as informational.
- `bun run arch:manifest-mirror` — passed.
- `bun run arch:compliance` — passed.
- `git diff --check` — passed.
- `bun run arch:tables` — passed: no cross-module schema access, raw-SQL, or platform-bypass evasion.

## Not executed

No full test suite, global build, live PostgreSQL/RLS suite, migration execution, worker activation, Claim.MD API call, or production operation was run. Unit mocks do not prove database atomicity, advisory-lock behavior, RLS, or concurrent delivery. Continue those in BIL-1.5 using a private PostgreSQL instance per repository policy.
