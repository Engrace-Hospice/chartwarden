# 23 — Data model and migration audit

The manifest is the table-ownership source of truth and the migration replay/gates cover 603 ordered
migrations at this baseline. Full replay, DDL legality, ownership, tenancy/FORCE RLS, numbering, and
baseline app-role RLS passed.

Key retained issues:

- Payer coverage has no effective-period non-overlap invariant (`CW-QA-0001`).
- One M17 owned table lacks live evidence (`CW-QA-0016`).
- Forward-only schema changes are not machine-enforced as old-code compatible (`CW-QA-0017`).
- Full production restore/PITR/object reconciliation is absent (`CW-QA-0013`).

No migration was run against the shared Docker cluster or production. The audit container used
`max_locks_per_transaction=4096`, one fresh database per live-suite group, and canonical app-role
testing. No rollback was attempted because migrations are explicitly forward-only.

Actual query plans, production statistics, bloat, pool utilization, lock graphs, and large-table
backfill duration were unavailable. Index gates reduce risk but are not a substitute for production-
scale EXPLAIN/ANALYZE and deployment rehearsals.
