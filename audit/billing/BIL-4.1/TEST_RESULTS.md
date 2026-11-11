# Test results

## Current source

- `scripts/test-m25-835-ingestion-private.sh`: final-source rerun passed in a fresh disposable `chartwarden-postgres:dev` container: M25 ingestion/controlled posting **46/46**; M25 835 golden/manual **21/21**; M23/M24 feedback **7/7**; M23/M26 CAP consumer **4/4**; synthetic clearinghouse pull **15/15**. The M25 suite exercised the 1- and 2-claim HTTP-to-PostgreSQL flow, distinct approver/executor, plan invalidation, disabled gate, event recovery/redelivery, legacy-first duplicate hold, multi-claim atomic rollback, idempotency, unsupported batch refusal, and a same-payment-identity/different-content duplicate refused at the locked transaction boundary.
- `packages/db/migrations/__tests__/m25-rls-isolation.live.test.ts`: **21/21 passed** on a separate fresh disposable PostgreSQL instance using `chartwarden_app` for RLS assertions. No schema migration was added in BIL-4.1.
- `apps/web/src/modules/25-remittance/claimmd-era-review.dom.test.tsx`: **9/9 passed** after adding the multi-claim plan table and committed batch result assertion.
- `bunx tsc -b ./apps/backend --pretty false`: passed after the final backend implementation and formatting changes.
- `NODE_OPTIONS=--max-old-space-size=3072 bunx tsc -b ./apps/web --pretty false`: passed with the bounded 3 GB heap.
- `bun run openapi:check`, `bun run client:check`: passed. The generated TypeBox/OpenAPI and client contracts are synchronized.
- `bun run arch:tables`, `bun run arch:tenancy`, `bun run arch:outbox-bindings`, `bun run arch:migration-numbering`, `bun run arch:migration-compat`: passed. No migration was added.
- `bunx biome check` on the six affected TypeScript/TSX files: passed after formatting.
- `git diff --check`: passed at closeout.

## Limits

The live PostgreSQL tests use synthetic data and private containers. They do not certify Claim.MD production routes, bank settlement, production migration/deployment, or automatic posting. No live vendor call was made.
