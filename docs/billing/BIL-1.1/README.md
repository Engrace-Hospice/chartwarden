# BIL-1.1 — Claim.MD account response capture

## Verdict

**NO-GO for production activation.** This change adds an inactive, account-wide response reader and durable encrypted capture primitives. It is not wired to backend startup or a scheduler, does not route captured events to tenant claims, and has not been certified against a live PostgreSQL role or Claim.MD account. No Claim.MD API calls were made.

## Scope and result

The implementation is a first, additive capture layer for Claim.MD's account-scoped incremental `/services/response/` stream. It scopes streams by a non-secret account reference and test/production usage; retains the complete response page encrypted; stores event digests and idempotency keys; and advances the cursor in the same transaction as durable page capture. Unknown or malformed message shapes are retained and marked for review. This is intentionally not an acknowledgment applier, tenant attribution engine, claim state transition, ERA feature, poller deployment, or UI.

The reader and bounded capture service are implemented as reusable code, but activation remains **Stub / inactive** pending credential provisioning, platform role registration, stream bootstrap, key management, live RLS/concurrency evidence, routing and operational controls. See [CAPTURE_FLOW.md](./CAPTURE_FLOW.md), [SECURITY.md](./SECURITY.md), and [CUTOVER_NOTES.md](./CUTOVER_NOTES.md).

## Files

- `packages/x12-837-client/src/clearinghouse/claimmd-account-response.ts` — account-wide response parser and reader.
- `apps/backend/src/modules/23-billing-medicare/claimmd-capture/` — encryption, store and one-tick capture service.
- `packages/db/migrations/1350_m23_claimmd_response_inbox.sql` and `packages/db/src/schema/billing/claimmd-response-inbox.ts` — isolated stream, encrypted page and event metadata tables.
- `architecture/module-manifest.ts` and `.cjs` — M23 table ownership; `scripts/check-tenancy.ts` — documented non-tenant-scoped tables.

## Remaining blockers

1. Confirm Claim.MD response endpoint semantics, account identity and separate test/production credential configuration against the contracted account and current official documentation.
2. Establish secret and encryption-key provisioning/rotation, platform principal binding, and approved stream bootstrap procedure.
3. Run private-PostgreSQL live tests for FORCE RLS, least privilege, leases/fencing, cursor atomicity, and multi-worker concurrency.
4. Implement a reviewed idempotent provider/claim resolver, tenant-scoped quarantined routing, replay/DLQ and evidence-backed status-stage mapping.
5. Add alerting, rate-budget coordination, retention/key recovery procedures, and staged rollout/rollback evidence.

The exact executed commands and results are in [TEST_RESULTS.md](./TEST_RESULTS.md).
