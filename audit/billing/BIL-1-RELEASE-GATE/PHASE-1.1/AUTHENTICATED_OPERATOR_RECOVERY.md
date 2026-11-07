# Authenticated operator recovery

**Status: BLOCKED for live authenticated recovery certification.**

The actual route is registered in `apps/backend/src/bootstrap/routes/ops-claimmd-era-recovery.ts` and the composition is in `apps/backend/src/index.ts`. It applies platform billing permission, `platform_billing_scope`, step-up, an authenticated context identity and an explicit platform role, then calls the recovery service. The route test at `apps/backend/src/bootstrap/routes/__tests__/ops-claimmd-era-recovery.test.ts` injects `request.context` and mocks `requeue`; it does not execute the actual auth plugin/resolver or PostgreSQL store.

Phase 1.1 did not claim those checks as certification. Tenant admin denial with persisted audit, duplicate action idempotency, stale/concurrent recovery, cursor immutability, and no financial effects were not exercised through a real authenticated request and DB.

The recovery endpoint remains an operationally sensitive platform route. Do not use it for live recovery until the full integration suite proves the actual authentication, permission, ABAC, fresh step-up, real recovery store, audit persistence and no-posting assertions.
