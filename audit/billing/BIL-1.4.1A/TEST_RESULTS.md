# Test results

## Executed

- `bun vitest run packages/x12-835-client/__tests__/parse-x12-835.test.ts packages/x12-835-client/__tests__/parse-x12-835-hardening.test.ts packages/x12-835-client/__tests__/parse-x12-835-671.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-resolution.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-routing.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-capture.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/capture.test.ts` — **89 tests passed across 7 files**.
- `bun run arch:tables` — passed.
- `bun run arch:tenancy` — passed.
- `bun run arch:ddl` — passed.
- `bun run arch:migration-compat` — passed; migration 1357 is additive `expand`.
- `bun run arch:migration-numbering` — passed; 1357 is uniquely claimed.
- `bun run arch:manifest-mirror` — passed.
- `bun run arch:compliance` — passed.
- `git diff --check` — passed.
- `bun run build` — **passed**, explicit exit code 0 across all 14 TypeScript project batches. (The initial run caught and led to correction of a test rootDir import.)
- `bun run typecheck:tests` — **passed** (both `tsconfig.tests.json` and `tsconfig.tests.dom.json`; exit 0).

No full test suite, live RLS tests, private PostgreSQL, live Claim.MD, service startup, or migrations were run.

The existing `packages/db/migrations/__tests__/m25-rls-isolation.live.test.ts` was extended to assert that the
tenant role cannot read the new resolution/history tables and that `claimmd_capture` has the required
central-table read grants. This live suite was typechecked but not executed; the assertions are not runtime
RLS certification.
