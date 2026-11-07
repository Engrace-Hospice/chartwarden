# BIL-1.5A.2 — M23 notice evidence compatibility

## Verdict

**Conditional source-level compatibility; no notice route is certified for Claim.MD transmission.** NOE and NOTR have durable `claim_submission` attempts before the worker starts; the outbox previously discarded their IDs. Transfer notices already carried the attempt ID. The transport required claim-only identifiers for all three, so Claim.MD notice sends failed closed. This change adds typed 837I notice evidence, binds it to the real notice and attempt, and keeps Claim.MD notice upload behind `M23_CLAIMMD_NOTICE_UPLOAD_ENABLED=true` (unset/anything else is off).

Successful upload continues to mean submitted to the transport. It does not mean payer acceptance. Claim.MD support for NOE, NOTR, and transfer notice semantics remains unverified; vendor acceptance and payer routing are external release gates.

## Code inventory

| Area | Source | Result |
|---|---|---|
| NOE/NOTR attempt creation | `apps/backend/src/modules/23-billing-medicare/routes/write-service-drizzle.ts` | Existing tenant-scoped queued attempts retained |
| NOE/NOTR queue bridge | `apps/backend/src/modules/23-billing-medicare/outbox-consumers/submit-requests.ts` | Now preserves attempt ID in worker job |
| NOE/NOTR transport | `apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts` | Now validates and passes original attempt identity |
| Transfer transport | `apps/backend/src/modules/23-billing-medicare/jobs/transfer-notice-jobs.ts` | Passes notice and attempt identity |
| Claim.MD boundary | `apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.ts` | Claims retain prior evidence path; notices use separate typed evidence, default disabled |
| Exact X12 parser | `packages/x12-837-client/src/clearinghouse/notice-submission-evidence.ts` | Institutional envelope/provider/payer identity and exact-byte digest |
| Persistence | `packages/db/src/schema/billing/claimmd-notice-submission-evidence.ts`, migration `1361_m23_claimmd_notice_submission_evidence.sql` | Tenant RLS, immutable evidence, append-only receipt observations |

## Boundaries

- No notice response is fed to the ordinary claim candidate resolver or BIL-1.3 claim status mapper.
- Receipt identifiers retain the vendor field and namespace. A file/batch receipt is not a notice acceptance.
- Legacy MAC upload behavior remains selected when the platform transport is unset.
- `M23_CLAIMMD_NOTICE_UPLOAD_ENABLED` is an additional opt-in, not a certification of Claim.MD or payer capability.
- No live Claim.MD call, migration execution, production rollout, or acknowledgment transition was performed.

See the remaining documents in this directory for source details, checks and blockers.
