# PostgreSQL financial tests

The changed authenticated HTTP-to-private-PostgreSQL test is in `apps/backend/__tests__/m25-835-ingestion.live.test.ts`, using the repository's disposable runner `scripts/test-m25-835-ingestion-private.sh`. It exercises the BIL-4.1 fully-paid one/two-claim cases and the new single partial claim case with synthetic source facts and actual database roles/services.

The partial case checks the $100 charge / $70 payment / $30 OA adjustment plan classification, committed M25 remittance and adjustment rows, absence of a patient-responsibility ledger entry, partial event rather than full-paid event, M41 `partially_paid` state after consumer delivery, and redelivery behavior.

Executed in this worktree:

- `scripts/test-m25-835-ingestion-private.sh` — PASS: M25 ingestion/plan/approval/execution PostgreSQL 47/47; legacy 835 golden/manual posting PostgreSQL 21/21; M23/M24 feedback PostgreSQL 7/7; M26 CAP consumer PostgreSQL 4/4; synthetic clearinghouse pull tests 15/15. Private runner created and removed its own PostgreSQL container.
- `bunx vitest run apps/backend/src/modules/25-remittance/ingest/__tests__/claimmd-financial-assessment.test.ts` — PASS: 10 tests (supported OA classification plus responsibility, mismatch, references, line, multiplicity and CARC blockers, including unmapped category refusal).
- `bunx vitest run packages/x12-835-client/__tests__/parse-x12-835.test.ts` — PASS: 41 tests, including a synthetic balanced claim-level OA partial-payment parse case.
- `bunx vitest run apps/web/src/modules/25-remittance/claimmd-era-review.dom.test.tsx` — PASS: 9 tests. The first run exposed an old mock plan missing newly required breakdown properties; fixture was updated and rerun.
- `bunx tsc -b ./apps/backend --pretty false` and `NODE_OPTIONS=--max-old-space-size=3072 bunx tsc -b ./apps/web --pretty false` — PASS.
- `bun run openapi:emit && bun run client:gen`; `bun run openapi:check`, `bun run client:check`, `bun run arch:tables`, `bun run arch:tenancy`, `bun run arch:outbox-bindings`, `bun run arch:migration-numbering`, `bun run arch:migration-compat`, `bun run ui:parity --check`, `bun run outbox:deferrals:update --check`, and `git diff --check` — PASS. No schema migration was added.

RLS/consumer evidence is from the private runner and real restricted application roles, not mocked tenancy assertions. The suite does not certify bank settlement or production activation.
