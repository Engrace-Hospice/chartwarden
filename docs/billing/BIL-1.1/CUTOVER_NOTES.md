# Cutover and rollback notes

## Current activation state

There is no boot registration, scheduler, account-key loader, platform-role wiring change, stream bootstrap, tenant event consumer, or feature-flag change. The migration may create capture tables and a dedicated role, but without an explicitly inserted stream row the capture service returns `NOT_BOOTSTRAPPED_OR_BUSY`. Keep the service inactive until all gates below have evidence.

### Tenant-owned Claim.MD capture status

Tenant-owned accounts still use the existing per-organization/provider ACK polling path. Do not enable a second BIL-1.1 poller for them: the legacy path has its own durable cursor and applies existing ACK behavior, while the current inbox is platform-role/platform-key owned and account-cursor based. Tenant archival requires a unified one-fetch pipeline and tenant-appropriate encryption/RLS plus a compatible cursor migration. No tenant cutover, backfill, or reset is part of CM-5A.2; the old path remains authoritative and its previously processed responses are not represented as archived inbox evidence.

## CM-5A.3A status

Migrations 1503–1504 and the tenant-owned encrypted inbox repository are implemented as a foundation only. The outcome ledger records idempotent downstream results and quarantine codes without mutating source evidence. The active `runTransportAckPull` poller still owns all tenant vendor reads and legacy ACK cursor writes. Its current transport exposes normalized events rather than the exact raw response page, so the archive-before-ACK adapter is not composed into it. The existing provider/ACK-type cursor coordinates have been inventoried read-only and are explicitly non-comparable; none has been reset, advanced, or collapsed into a new account cursor. The account `coverage_started_at` is the prospective start of verified archival, not a claim that prior responses exist in the inbox.

No live cutover, historical replay, or vendor polling is authorized. Before any later integration, establish the actual vendor account identity with auditable evidence (the current config has no vendor-issued account ID), add an exact-raw-page transport seam to the existing single poller, define archive/ACK/cursor transaction boundaries and fencing, provision tenant key access, and execute migrations 1503–1504 against the approved isolated PostgreSQL application-role/RLS and concurrency suite. Rollback must leave the legacy cursor untouched and must not delete encrypted evidence.

## Staged activation plan

1. Provision separate test and production account credentials through the approved secret store; provision and document the encryption keyring and rotation/recovery process.
2. Validate deployed DB roles, platform job registration, role membership, FORCE RLS, and audit evidence with the private PostgreSQL live suite (`test:m23:claimmd-response-inbox:live`).
3. Bootstrap one test stream with an operator-reviewed account reference and initial cursor. Run against synthetic vendor test data only; prove raw pages remain encrypted and unresolved events retained.
4. Implement downstream inbox routing with explicit provider/claim identity resolution, tenant-scoped destination checks, quarantine, idempotent replay and status provenance. Do not fan out by caller scope.
5. Shadow-poll in test, then production only after vendor contract/account approval, shared-account rate coordination, alerting and rollback rehearsal. Ensure one poller per account/usage stream through leases/fencing.

## Migration rollback

Migration 1350 is additive (`compat: expand`). Before any real capture, rollback can drop the three new tables and role grants/role after confirming no dependencies; preserve encrypted captured batches for forensic/replay needs once activation begins. After capture starts, do not delete tables or rows as routine rollback. Disable scheduling, retain the inbox and cursor, and roll forward a compatibility fix. Cursor rewind/replay requires an audited operator action and duplicate handling by the durable event keys.
