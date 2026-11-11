# PostgreSQL and HTTP test results

- `BIL_TEST_ONLY=m41 bash scripts/test-m25-835-ingestion-private.sh`: **PASS, 16/16**, private disposable PostgreSQL.
- `BIL_TEST_ONLY=claimmd-ops bash scripts/test-m25-835-ingestion-private.sh`: **PASS, 4/4**, real platform readers and restricted roles.
- Focused observability/health/readiness route tests: **PASS, 5/5**.
- Billing Operations, M41 detail and admin recovery DOM tests: **PASS, 22/22**.

No shared `os-postgres-1`, production database or live vendor endpoint was used.
