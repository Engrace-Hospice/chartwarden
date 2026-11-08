# Platform ERA recovery

## Invocation

The internal operations route is `POST /api/v1/ops/claimmd/eras/{inboxId}/recovery`, registered from `apps/backend/src/index.ts` only when the recovery service can be composed with platform and tenant DB handles, a valid central account reference/environment and the protected inbox keyring. No Claim.MD API credential is required to compose recovery and no Claim.MD request is made.

The route calls `createClaimMdEraRecoveryService().requeue()`; it is not a dry-run command. Its body is:

```json
{
  "actionId": "<new UUID for this operator action>",
  "accountReference": "<configured account reference>",
  "usage": "test",
  "stage": "capture",
  "reasonCode": "OPERATOR_RETRY",
  "expectedState": "retryable_failure",
  "expectedVersion": 5
}
```

The path uses the internal ERA inbox UUID. Supported stages are `capture`, `ownership_resolution`, and `m25_delivery`. `expectedVersion` means capture retry count, ownership resolution version, or delivery attempt count, respectively. Use the current durable state snapshot to populate both expected fields. Use a fresh UUID for a new intended action; reusing an action ID with different request identity is rejected. Authentication requires the platform billing rule-config permission and recent step-up. The actor ID is taken from the authenticated request context; caller-supplied actor, organization, provider, ownership or payload fields are not accepted.

Responses contain the recovery receipt/state and do not include 835 content or tenant financial details. Invalid request data fails before the service call. The store appends an audit outcome for valid scoped operations when the target is present. Authentication failures remain in the repository's request/security audit path rather than creating a central ERA recovery row.

## Domain safeguards

`apps/backend/src/modules/25-remittance/ingest/claimmd-era-store.ts` performs a transaction with source/delivery/resolution row locks and optimistic state/version checks. It binds the operation to the original account/environment and inbox UUID. Capture retries require exhausted, retryable capture state and are capped. Ownership retry delegates to the existing resolver, which verifies source evidence and does not turn a conflict into verified ownership. Delivery recovery requires a verified unchanged resolution and matching digest/version/owner snapshot. Already delivered or duplicate-classified delivery is reconciled; it is not blindly recreated. Recovery does not modify source bytes, account cursor, ownership, or posting state.

Durable action IDs make repeat calls idempotent when the action identity matches. Conflicting reuse is rejected. Recovery history is append-only in the existing recovery audit table; this phase adds no parallel queue or new schema.

## Limitations

The route is available only on a runtime where protected-store prerequisites allow composition. It does not create a tenant-facing recovery API. The existing service does not offer arbitrary resolution ownership changes or a generic override operation. Real database races, role grants, row-level security and crash behavior must be tested in BIL-1.5B against a private disposable PostgreSQL instance.
