# Test results

All PostgreSQL runs used `scripts/test-m25-835-ingestion-private.sh`, which starts a fresh disposable `chartwarden-postgres:dev` container on loopback and runs M25/M23/M24/M26 suites with the restricted application role. No shared database was used.

| Command within private runner | Result |
|---|---:|
| `apps/backend/__tests__/m25-835-ingestion.live.test.ts` | 41 passed |
| `apps/backend/__tests__/m25-835-golden.live.test.ts` | 21 passed |
| `apps/backend/__tests__/f172-m24-remittance-feedback.live.test.ts` | 7 passed |
| `apps/backend/__tests__/gap-038-cap-day-backfill.live.test.ts` | 4 passed |
| `apps/backend/__tests__/m25-clearinghouse-pull.test.ts` | 15 passed |

Focused regressions:

- `bunx vitest run apps/backend/src/modules/25-remittance/routes/__tests__/claimmd-era-review.routes.test.ts apps/backend/src/modules/25-remittance/ingest/__tests__/historical-match-candidate.test.ts apps/web/src/modules/25-remittance/claimmd-era-review.dom.test.tsx` — 3 files, 23 passed.
- `bun run build` — 14/14 TypeScript build batches passed.
- Targeted `tsc` programs for the M25 live/history tests and the ERA DOM test — passed; temporary configs were removed.
- `bun run arch:tenancy`, `arch:tables`, `arch:outbox-bindings`, `arch:migration-numbering`, `arch:migration-compat`, `arch:merge-artifacts`, `openapi:check`, and `client:check` — passed.
- `git diff --check` — passed.

The M25 live suite includes both duplicate arrival orders, route-to-PostgreSQL execution, authorization/step-up denials, outbox lease recovery and M41 consumer redelivery. The golden suite verifies the real parser and legacy posting workflow. M23/M24 and M26 runs validate the affected downstream consumers.

Additional focused route/historical-candidate/UI tests, test-file TypeScript checks, architecture checks, and final diff checks are recorded here after their final run. No global monorepo test suite or live vendor requests were run.
