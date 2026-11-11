# PostgreSQL and Financial Tests

Private execution used `scripts/test-m25-835-ingestion-private.sh`, which creates a fresh disposable `chartwarden-postgres:dev` container, random localhost port and database, then removes the container. The M25 live suite uses the restricted application role and RLS checks. Shared `os-postgres-1` was not used.

Latest run of `scripts/test-m25-835-ingestion-private.sh`: all suites passed — `m25-835-ingestion.live.test.ts` **49/49**; `m25-835-golden.live.test.ts` **7/7**; `f172-m24-remittance-feedback.live.test.ts` **4/4**; `gap-038-cap-day-backfill.live.test.ts` **15/15**; `m25-clearinghouse-pull.test.ts` **15/15**. Total **90 tests** across five files. The M25 live suite includes synthetic PLB source/balance, stage details, plan blocker and tenant-authorized follow-up persistence with no advice/outbox posting side effect. The golden and downstream suites cover legacy manual/SFTP and M24/M23/M26 behavior.

Focused non-live command: `bunx vitest run packages/x12-835-client/__tests__/parse-x12-835.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-era-review.test.ts apps/backend/src/modules/25-remittance/domain/__tests__/era-financial-review.test.ts apps/backend/src/modules/25-remittance/domain/__tests__/adjustment-policy.test.ts apps/web/src/modules/25-remittance/claimmd-era-review.dom.test.tsx` — **5 files, 65 tests passed**.

No database migration was introduced. These tests do not certify PLB/reversal/recoupment financial execution; none is implemented.

Static checks: `bun run build` passed; `bun run openapi:emit`, `bun run client:gen`, and `bun run client:check` passed; `bun run arch:tenancy`, `arch:tables`, `arch:migration-numbering`, `arch:migration-compat`, `arch:openapi-provenance`, `arch:outbox-bindings`, `arch:ui-parity`, `arch:route-reachability`, and `arch:merge-artifacts` passed. Focused non-live tests were rerun after the parser type correction; `git diff --check` passed. The full `typecheck:tests` project was not run.
