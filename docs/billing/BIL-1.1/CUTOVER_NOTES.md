# Cutover and rollback notes

## Current activation state

There is no boot registration, scheduler, account-key loader, platform-role wiring change, stream bootstrap, tenant event consumer, or feature-flag change. The migration may create capture tables and a dedicated role, but without an explicitly inserted stream row the capture service returns `NOT_BOOTSTRAPPED_OR_BUSY`. Keep the service inactive until all gates below have evidence.

## Staged activation plan

1. Provision separate test and production account credentials through the approved secret store; provision and document the encryption keyring and rotation/recovery process.
2. Validate deployed DB roles, platform job registration, role membership, FORCE RLS, and audit evidence with the private PostgreSQL live suite (`test:m23:claimmd-response-inbox:live`).
3. Bootstrap one test stream with an operator-reviewed account reference and initial cursor. Run against synthetic vendor test data only; prove raw pages remain encrypted and unresolved events retained.
4. Implement downstream inbox routing with explicit provider/claim identity resolution, tenant-scoped destination checks, quarantine, idempotent replay and status provenance. Do not fan out by caller scope.
5. Shadow-poll in test, then production only after vendor contract/account approval, shared-account rate coordination, alerting and rollback rehearsal. Ensure one poller per account/usage stream through leases/fencing.

## Migration rollback

Migration 1350 is additive (`compat: expand`). Before any real capture, rollback can drop the three new tables and role grants/role after confirming no dependencies; preserve encrypted captured batches for forensic/replay needs once activation begins. After capture starts, do not delete tables or rows as routine rollback. Disable scheduling, retain the inbox and cursor, and roll forward a compatibility fix. Cursor rewind/replay requires an audited operator action and duplicate handling by the durable event keys.
