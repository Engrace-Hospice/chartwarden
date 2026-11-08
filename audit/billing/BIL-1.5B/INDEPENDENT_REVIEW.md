# Independent source review

A separate read-only reviewer inspected the BIL-1 stack with emphasis on RLS, privileged operations, evidence, workers, metrics and money. It found four actionable issues:

| Severity | Finding | Correction |
|---|---|---|
| Critical | Tenant `org_admin` could obtain the billing permission and invoke cross-tenant ERA recovery with step-up; route created a platform actor without platform-role proof. | Compose `platform_billing_scope`, require an authenticated platform-owned role explicitly, and add a tenant-admin denial regression. |
| High | Recovery store used an unregistered platform job ID and could not execute. | Register the recovery job during runtime composition and test denied-before/allowed-after behavior. |
| Medium | Durable metrics on API roles used capture/delivery job identities registered only with workers. | Use dedicated read-only metrics job IDs registered at metrics composition. |
| Concurrency risk | Failed source revalidation could downgrade a terminal ERA delivery. | Preserve terminal state in the locked store transaction; skip tenant stage hold on terminal receipt; add a focused regression. |

Reviewer found no additional confirmed high-severity flaw in the sampled RLS, identity, evidence, cursor or financial posting paths. This is an independent source review, not PR approval, CI security signoff or complete live PostgreSQL certification. Exact code paths: `apps/backend/src/bootstrap/routes/ops-claimmd-era-recovery.ts`, `modules/25-remittance/ingest/claimmd-era-recovery.ts`, `claimmd-era-store.ts`, `claimmd-era-delivery.ts`, and `modules/23-billing-medicare/claimmd-capture/operational-reader.ts`.
