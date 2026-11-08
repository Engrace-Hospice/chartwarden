# Workers, fencing and concurrency

The private response inbox suite proves one PostgreSQL lease winner with two connections and a generation increment of one. The M23 clearinghouse live suite exercises uncertain-send and retry paths; detailed result is in `TEST_RESULTS.md`. The M25 ingestion live suite exercises concurrent duplicate financial posting and cross-source intake. The focused ERA delivery regression prevents a concurrent failed source revalidation from downgrading a terminal receipt (`claimmd-era-store.ts`, `claimmd-era-delivery.ts`).

BIL-1.5B corrected a runtime denial: the recovery store used `CLAIMMD_ERA_RECOVERY_JOB_ID` without registering it. `registerClaimMdEraRecoveryPlatformJob()` is called during recovery composition, with a focused denial/allowance test. Separate read-only platform job IDs now serve response and ERA durable metrics; their registration does not enable capture workers.

**Pending:** live two-process fencing/restart tests for every account-wide worker, PostgreSQL-backed ERA delivery interruption/reconciliation, and full authenticated recovery audit/state concurrency. Existing unit coverage is not a substitute for those tests. All new workers remain disabled by default.
