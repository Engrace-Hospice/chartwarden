# Remaining blockers

| Priority | Type | Component | Impact | Required action |
|---|---|---|---|---|
| P1 | Runtime certification | Recovery/metrics DB roles, RLS, transaction locks | Source tests cannot establish real cross-tenant isolation, uniqueness, recovery concurrency or durable state after crash. | BIL-1.5B private disposable PostgreSQL runs from the correct migration baseline as NOBYPASSRLS app role and approved platform role. |
| P1 | Observability completeness | Financial safety and per-stage telemetry | Durable metrics cover state backlogs, but not all historical duplicate attempts, posting guard failures, lease contention or retry events independently. | In BIL-1.5B identify existing audit/event source; add narrowly scoped durable event metrics only if required, without redundant counters. |
| P1 | Readiness certification | Enabled worker dependencies | `/ready` capability map is composition status, not a live per-dependency readiness proof; runtime role/lease/rate-limit/keyring behavior needs isolated certification. | BIL-1.5B test enabled worker preflights and actual permissions/fencing. |
| P1 | Deployment safety | Legacy/new workers | New-version guards do not fence old binaries during rolling deployment. | Require operator quiescence and fleet-wide guarded deployment before any activation; verify topology. |
| P1 | Vendor | Hospice notice route | Claim.MD notice-specific submission and acknowledgment support is unverified; route remains disabled/degraded. | Obtain vendor written confirmation and test-account protocol before notice activation. |
| P1 | Financial | Cross-source posting | This phase did not run PostgreSQL concurrency tests or certify every manual/SFTP/API producer reaches the shared financial guard. | Trace every producer and execute BIL-1.5A.1 financial concurrency scenarios in BIL-1.5B. |
| P2 | Release | Branch/PR | Worktree contains cumulative dirty BIL-1.5A, A.1, A.2 and A.3 changes; this phase has not received independent review or been committed. | Preserve ancestry; review and commit the intended stack in the established branch process. Do not merge before the BIL-1 Release Gate. |
