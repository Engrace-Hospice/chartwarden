# BIL-3.1 — ERA history and staging visibility

Implemented on the existing M25 Claim.MD review endpoints and Revenue Cycle screen. Detail now includes a tenant-authorized projection of durable capture, ownership, delivery and recovery records. List filters are applied before keyset pagination; payer search is bounded to 500 stage summaries per request. The flow remains read-only and nonposting.

No migration was required. Existing central history and tenant-stage records are reused. PostgreSQL/RLS runtime certification was not executed in this phase; see `POSTGRESQL_AND_RLS.md`.
