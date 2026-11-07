# Test results

- `bunx vitest run apps/backend/src/modules/23-billing-medicare/claimmd-capture/config.test.ts apps/backend/src/modules/23-billing-medicare/claimmd-capture/capture.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-review.test.ts` — 3 files, 7 tests passed.
- `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false` — passed after latest financial guard edits. The default-memory direct invocation exited 134 (Node heap OOM), so the project-prescribed memory setting was used.
- `bun run arch:tenancy`, `bun run arch:ddl`, `bun run arch:migration-compat`, `bun run arch:migration-numbering` — passed.
- `bun run arch:tables` — started twice and interrupted after prolonged silence (>40 seconds); no pass is claimed.
- `bun run build` was started accidentally and interrupted during whole-monorepo project graph/type batches; it is not a successful verification. `bun run typecheck:tests` was also interrupted. No full test suite was run.
- `git diff --check` — passed after final source and documentation edits.

No live Claim.MD call, production migration, service deployment, or shared PostgreSQL test was performed. Private PostgreSQL tests remain required.
