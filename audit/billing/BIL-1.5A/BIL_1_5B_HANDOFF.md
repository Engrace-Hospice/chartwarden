# BIL-1.5B handoff

BIL-1.5B may begin only after the P1 implementation gaps in `RELEASE_BLOCKERS.md` are corrected. Its cumulative plan should run the full Lot 1 focused suites, private PostgreSQL tenant/role/financial/concurrency tests, migration ordering including contract migration 1358, feature-flag mutual-exclusion matrix, and shadow comparison. Never use the shared `os-postgres-1` cluster. Keep all runtime flags off and do not invoke Claim.MD.
