# Integration and security results

## Verified source boundaries

- **M23:** `apps/backend/src/modules/23-billing-medicare/routes/claims.routes.ts:320-401,452-513` exposes scoped preview and requires the matching confirmation, current claim version, re-resolved payer route and renderer source fingerprint before reserving submission. Worker code in `apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts:1371-1449` rechecks the persisted fingerprint and holds stale source before dispatch. Transport final-byte evidence remains in `jobs/clearinghouse-submission.ts`.
- **M41:** `apps/backend/src/modules/41-billing-commercial/services/claim-assembly.ts:165-205` accepts only an actual clearinghouse rejection with no payer-stage acknowledgment. The parent claim is locked and tenant/caseload checked before creating a single correction (`:214-279`). Submission route requires permission, caseload, fresh step-up, non-AI actor and idempotency (`routes/commercial-billing.routes.ts:265-283`).
- **M24:** the route is protected by submit permission, claim ABAC, step-up and AI rejection (`routes/claims.routes.ts:160-180`). The worker checks route readiness before credential resolution (`jobs/submission-jobs.ts:180-205`). The registry's current capability is explicitly local-only/unverified (`packages/medicaid-adapters/src/registry.ts:95-152`).

## Corrected defect

Migration 1380's correction identity `CHECK` allowed SQL `UNKNOWN` because PostgreSQL considers a `CHECK` satisfied when its expression is `NULL`. The service supplied metadata, but the database boundary did not require it. Added migration 1381 with explicit `IS NOT NULL` requirements for linked rows and allowed reason/key validation; mirrored the check in `packages/db/src/schema/billing-commercial/claims.ts:126-144`. A private PostgreSQL regression test attempts to insert a linked correction with missing reason and request key and expects the named constraint.

Also updated the M23 RLS integration fixture to follow the actual dispatch trigger: reserve `pending → sending`, then terminalize to `finished/submitted`; direct queued-to-terminal mutation is no longer an allowed lifecycle (`packages/db/migrations/__tests__/m23-rls-isolation.live.test.ts:373-414`).

The private M23 worker suite exposed three retry-integrity defects and now passes 17/17: `runClaimSubmitRetry` did not forward the immutable reviewed-source fingerprint to the next worker job; transport errors lost the port's `ambiguous` bit, causing a known pre-send refusal to remain in doubt; and a late retry after terminal success could append an unnecessary attempt. These are fixed in `apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts` and `jobs/clearinghouse-submission.ts`, with focused unit/live regression coverage. Uncertain outcomes still remain in doubt and are never blindly resent.

## Authorization limits

M23 and M24 FORCE RLS tests used the actual `chartwarden_app` NOBYPASSRLS role. M41 private suites exercised real PostgreSQL constraints and service scope. The M41 route test's auth context is a test harness, not production IdP/step-up cryptographic certification. No live shared Claim.MD account capture or cross-tenant vendor response collision was attempted.
