# Non-regression and side-effect boundaries

- M23/M24/M25/M41 read APIs remain the data owners. The workspace does not call a write endpoint.
- The existing M25 matching, financial review, approval, execution and posting history flows remain in the M25 screen. Deep-link support only selects a listed stage and performs existing authorized reads.
- M25 location filtering narrows the existing stage list; it does not modify a stage or its source evidence.
- The actor-context response addition is an additive selector field; existing role, permission and location fields are unchanged.
- No migration, outbox binding, posting flag, worker, financial event, or accounting rule changed.
- `CLAIMMD_ERA_CONTROLLED_POSTING_ENABLED` remains default-disabled by existing configuration; no production activation was performed.

The private M25 regression runner passed as recorded in [PostgreSQL and RLS tests](POSTGRESQL_AND_RLS_TESTS.md). Existing all-work/NOE/NOTR/DDE pages and Revenue Cycle navigation remain registered.
