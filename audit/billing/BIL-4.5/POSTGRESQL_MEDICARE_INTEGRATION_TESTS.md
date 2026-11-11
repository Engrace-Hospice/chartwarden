# PostgreSQL Medicare Integration Tests

Command: `scripts/test-m25-835-ingestion-private.sh`. The script created a fresh disposable `chartwarden-postgres:dev` container on a private localhost port, applied migrations and ran the live suites using the restricted application role. It did not use shared `os-postgres-1` or a production database.

The new scenario in `apps/backend/__tests__/m25-835-ingestion.live.test.ts` persists a synthetic M23 claim submission and transport attempt, writes immutable parent/line evidence through the M23 evidence store, mutates the current claim total to a different value, then reads candidates through the M23 owner reader under app-role RLS. The candidate retains the submitted 4,200 cents. A staged Medicare ERA resolves to that M23 claim; review completes; plan eligibility is blocked; approval returns `POSTING_PLAN_STALE_OR_BLOCKED`; no remittance, remittance line, or posting success event is written.

This is a synthetic private database integration, not Claim.MD/MAC certification. Exact suite counts are recorded in [cumulative regressions](CUMULATIVE_BILLING_REGRESSIONS.md).
