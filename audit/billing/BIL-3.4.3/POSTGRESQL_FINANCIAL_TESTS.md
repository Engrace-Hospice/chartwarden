# PostgreSQL financial tests

## Environment and command

Run `./scripts/test-m25-835-ingestion-private.sh`. It requires the locally available `chartwarden-postgres:dev` image (override with `M25_TEST_PG_IMAGE`), starts a fresh loopback-only disposable container, uses the existing M25 live suite with its real `chartwarden_app` role, and removes the container on exit. It never reads the application `.env` database URL and does not connect to shared `os-postgres-1`.

## Current run

Executed against the repository PostgreSQL 18 test image on 2026-11-09:

- `apps/backend/__tests__/m25-835-ingestion.live.test.ts`: **39/39 passed**.
- `apps/backend/__tests__/f172-m24-remittance-feedback.live.test.ts`: **7/7 passed**; this existing live suite drains durable M25 payment events through the real dispatcher into the M23/M24 consumers. Two fixtures were corrected to include distinct synthetic TRN values required by the existing financial-identity guard; the guard itself was not relaxed.
- `apps/backend/__tests__/gap-038-cap-day-backfill.live.test.ts`: **4/4 passed**; the existing integration verifies M23/M26 claim-payment and CAP accrual consumer behavior through the durable outbox path.
- This includes legacy receive/post, existing matching and deduplication regressions plus four transaction-core cases: explicit association and persisted outbox, caller rollback, scope/source/unsupported-fact refusal, and concurrent idempotent execution.
- Successful case persisted one `remittance_line` for the selected synthetic claim with `$42.00`, `manual` association strategy, `posted` state, and one each of the transactional `m25.remittance.claim_paid` and `m25.remittance.advice_posted` events.
- Rollback case left no remittance line, no posted parse state and no posting outbox event.

The new test validates M25's transactional publication boundary. The two downstream suites validate M23/M24 state handling and M23/M26 CAP accrual processing. They do not certify a bank/AR accounting ledger. No live clearinghouse call or production migration occurred.
