# PostgreSQL financial tests

Run through `scripts/test-m25-835-ingestion-private.sh`, which starts a fresh private disposable PostgreSQL container using the repository image and the restricted application role. The M25 ingestion live suite covers a two-claim explicit transaction, two claim-paid events, one advice-posted event, replay idempotency, a forced second-line failure with rollback, and authenticated staged ERA preparation/approval/execution for one and two claims using the actual M41 history reader. The authenticated flow also verifies distinct approver/executor, source staleness, disabled-gate refusal, outbox recovery/redelivery and the legacy-first duplicate hold.

Exact cumulative outcomes are recorded in `TEST_RESULTS.md` after the current run. Tests use synthetic data; no live vendor request or shared database is used.
