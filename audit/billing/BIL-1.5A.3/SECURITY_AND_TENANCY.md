# Security and tenancy

The central inbox and account-wide aggregates remain internal platform operations. The recovery route accepts an internal inbox UUID, fixed account/environment, action identity and expected version, but no tenant or provider selector. Operator authentication and step-up happen before the service call, and the actor comes from trusted request context.

Response and ERA metrics use audited platform execution contexts and aggregate-only reads. M25 financial aggregates use the owning M25 reader with organization context and no tenant/provider labels. None of these readers decrypt protected payloads. Metrics labels are allowlisted bounded pipeline/measure names. Operational logs use safe summaries and failure codes, not payloads or credentials.

Recovery preserves the immutable original 835, verified ownership, resolution history, delivery history and account cursor. It schedules only an existing bounded retry/re-evaluation transition; it does not invoke M25 posting, emit posting events, or mutate payments/AR. Existing financial posting and manual review protections are unchanged.

Source inspection and mocked tests do not certify RLS or grants. BIL-1.5B must use an isolated PostgreSQL cluster and the actual NOBYPASSRLS application role to test cross-tenant denial, central platform access, recovery auditing, transaction serialization and stage-table protections. Do not use the shared `os-postgres-1` cluster.
