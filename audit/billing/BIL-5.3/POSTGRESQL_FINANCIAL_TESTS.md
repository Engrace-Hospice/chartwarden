# PostgreSQL financial tests

The new test is part of `apps/backend/__tests__/m25-835-ingestion.live.test.ts` and is run through `scripts/test-m25-835-ingestion-private.sh`, which creates a fresh private disposable PostgreSQL container using the repository test image and the live suite's restricted application role. It registers the actual M25 read routes and uses persisted synthetic M25 advice. It checks exact cents, org/provider scoping and unchanged advice/line/outbox counts across reads.

The test does not prove M41-to-M25 financial reconciliation, M24 aggregation, or canonical A/R because those contracts are not implemented. Results and any environment limitation are recorded in `TEST_RESULTS.md`.
