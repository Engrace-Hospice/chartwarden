# Financial regression results

Executed `scripts/test-m25-835-ingestion-private.sh` on a fresh private disposable PostgreSQL container using the repository's restricted application role:

| Suite | Result |
|---|---:|
| `m25-835-ingestion.live.test.ts` | 50/50 passed |
| `m25-835-golden.live.test.ts` | 21/21 passed |
| `f172-m24-remittance-feedback.live.test.ts` | 7/7 passed |
| `gap-038-cap-day-backfill.live.test.ts` | 4/4 passed |
| `m25-clearinghouse-pull.test.ts` | 15/15 passed |

Total: **97 passed**. The M25 ingestion suite includes the BIL-4.5 Medicare review plus the new attempted execution with synthetic approval. Existing full-paid, multi-claim, OA partial, adjustment policy blockers, PLB review, rollback, duplicate and M25 outbox cases remain covered by the current suite. The golden/manual suite covers legacy ingestion behavior. These are private synthetic tests; no vendor or bank interaction occurred.

TypeScript verification: the application/package build (13 project-graph batches) passed; `NODE_OPTIONS=--max-old-space-size=8192 bunx tsc -p tsconfig.tests.json --pretty false` and the corresponding `tsconfig.tests.dom.json` check both passed. The full `bun run typecheck` invocation was interrupted during its combined test-check stage, so its constituent checks were run separately and passed. The initial test typecheck exposed five errors in the changed live test; they were corrected (CAS fixture quantity, explicit callback type, and null guards).

`bun run lint` passed across **8,935 files**. Three existing formatting-only files outside BIL-4 needed mechanical formatting so the repository-wide lint gate could pass; no logic was changed. `git diff --check` passed.
