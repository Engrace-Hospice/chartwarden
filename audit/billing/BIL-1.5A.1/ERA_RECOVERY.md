# ERA Recovery

## Implemented

`createClaimMdEraStore().recover()` in `apps/backend/src/modules/25-remittance/ingest/claimmd-era-store.ts` uses audited `withPlatformContext` under `m25-claimmd-era-recovery`. It scopes by inbox UUID, account reference and usage, locks the central inbox row, validates expected state/version, and appends `claimmd_era_recovery_action` in the same transaction as accepted recovery. Duplicate action UUIDs are idempotent; after waiting on the row lock, the store re-reads the action receipt.

Capture retry is limited to retry-exhausted `retryable_failure`; it resets only the retry counter/error, not the ERA bytes or cursor, and caps operator recovery at three actions. Ownership re-evaluation rejects `verified` and `conflict`; requeued ownership is passed to the existing cryptographic resolver, which appends a new resolution version. Delivery recovery is limited to held safe error codes, requires the same captured digest and verified resolution/version/owner, and caps operator delivery recoveries at three. Already terminal deliveries are reconciled rather than re-executed. Delivery history is appended.

Errors in the recovery state transition attempt a second safe audit insert with `outcome=rejected`; operational database failure may prevent this secondary insert, so that failure path still requires live DB validation and alerting.

## Not yet operable

`createClaimMdEraRecoveryService()` requires an injected `authorize(actor)` check and has unit tests for denial/re-evaluation semantics, but the backend composition root does not instantiate it and no platform-ops route or CLI calls it. This is a source-level completion gap, not merely a runtime certification gap. Do not claim an operator can requeue today.

No recovery advances account cursors, changes source ciphertext, assigns tenant/provider identity, or calls a posting method. The existing recovery operation has no ability to set status to verified.

## Acceptance for follow-up

- Invoke only from an authenticated platform operations boundary using platform-ops authorization and step-up.
- Require reason code, action UUID, expected state/version and account/environment.
- Prove concurrent same-action requests return one receipt; stale competing requests are rejected and audited.
- Prove ownership conflicts cannot become verified and terminal delivery is reconciliation-only.
- Prove no tenant route or caller-supplied organization/provider can target another tenant.
