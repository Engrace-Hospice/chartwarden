# Operator ERA recovery certification

## Source path

`POST /api/v1/ops/claimmd/eras/{inboxId}/recovery` is registered as a platform-only route. It requires the platform billing permission, `platform_billing_scope` ABAC, fresh step-up, an authenticated context user ID, and an explicit platform-owned role. Caller-supplied actor identity is ignored. Account/environment must match the configured runtime binding. The response contains a safe state receipt, not cross-tenant ERA content. See `apps/backend/src/bootstrap/routes/ops-claimmd-era-recovery.ts`.

The actual service writes idempotent durable recovery history and uses optimistic state/version checks under the audited platform execution job. Tenant ownership, original ERA evidence and account cursor are not reassigned or advanced. Recovery does not call the financial posting service.

## Test result

The route, recovery service, recovery store and operational metric tests are part of the 92-test focused run. They prove tenant admin denial even with mocked billing permission/step-up, account mismatch and missing reason rejection, server-derived actor identity, reason/action identity, and platform job registration.

## Required before activation

The route test uses a synthetic request context and a stub service; real authentication plugin, authorization resolver, PostgreSQL central inbox, persisted success/rejection audit, duplicate action, stale version, simultaneous operators and no-posting effects have not been exercised together. This remains a P1 blocker for controlled-test recovery. Use a private database and the actual auth plugin; do not substitute a request body operator name.
