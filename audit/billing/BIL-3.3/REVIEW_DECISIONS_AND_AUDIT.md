# Review decisions and audit

Migration `1395_m25_claimmd_era_financial_review_decisions.sql` adds M25-owned `claimmd_era_financial_review_decision`. Rows bind organization, provider, staged ERA, ERA/claim item, version, disposition, source digest, hashed idempotency key, reason, authenticated membership and timestamp. RLS is enabled and forced; application role has SELECT/INSERT only; UPDATE/DELETE are rejected by an immutable trigger. Unique item/version and organization/idempotency constraints provide database backstops.

`POST /api/v1/remittance/claimmd-era/:id/financial-review/decision` enforces the separate permission and idempotency header. The service re-reads the authorized stage, locks it and takes an advisory transaction lock for the item, checks source/version/state, and appends a decision. It does not publish events or call posting services.

The API returns membership ID as the recorded reviewer identity; frontend renders a short reviewer reference with UTC timestamp. Human display-name resolution is not added here.
