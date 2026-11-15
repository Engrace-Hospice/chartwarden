# BIL-1.1 — Claim.MD account response capture

## Verdict

**NO-GO for production activation.** The platform-account capture worker is now composed behind the explicit `CLAIMMD_RESPONSE_CAPTURE_ENABLED=true` opt-in, validates its stream bootstrap and key/rate-limit dependencies, and polls only the platform Claim.MD account. It does not route captured events to tenant claims. No live Claim.MD API call was made for this change, and runtime PostgreSQL/RLS qualification remains outstanding.

## Scope and result

The implementation is an additive capture layer for Claim.MD's account-scoped incremental `/services/response/` stream. It scopes streams by a non-secret account reference and test/production usage; retains exact JSON or XML response text inside an encrypted versioned envelope; stores event digests and idempotency keys; and advances the cursor in the same transaction as durable page capture. XML parsing rejects DTD declarations and external entities. Unknown or malformed message shapes are retained and marked for review. Empty polls with an unchanged cursor update the successful-poll timestamp without inserting empty inbox batches. This is intentionally not a tenant attribution engine, claim-state transition, ERA feature, or UI.

The reader and bounded capture service are implemented. Activation remains opt-in and is blocked pending approved credential/key provisioning, platform role registration, operator stream bootstrap, live RLS/concurrency evidence and operational controls. Tenant-owned Claim.MD accounts remain on the existing tenant-scoped acknowledgment poll; they are not copied into this platform-only encrypted inbox. CM-5A.2 inspection confirmed this is not a safe “add an archive callback” change: the legacy poller consumes normalized ACKs per organization/provider and advances its own cursor after applying them, while BIL-1.1 owns raw account pages under a separate account cursor/lease, platform-only DB role, and platform encryption key. Starting both would create competing reads/cursors; putting tenant pages into the current inbox would cross the established key/RLS ownership boundary. The tenant archival cutover therefore remains disabled and CM-5A.2 is not complete. See [CAPTURE_FLOW.md](./CAPTURE_FLOW.md), [SECURITY.md](./SECURITY.md), and [CUTOVER_NOTES.md](./CUTOVER_NOTES.md).

## Verified vendor contract

The current official [Claim.MD API documentation](https://api.claim.md/) describes `POST /services/response/` with `AccountKey` and required `ResponseID`, with the initial incremental request at `0`, and the returned `last_responseid` as the subsequent cursor. The documented account-wide response service is capped at 20,000 results per request. WardenX requests `Accept: application/json` and also has a bounded, safe parser for the documented XML attribute envelope. The public API overview states no more than 100 API requests per minute; WardenX's shared request budget stays below that ceiling. The [Claim.MD transaction-support FAQ](https://docs.claim.md/docs/which-x12-claim-status-and-acknowledgment-transactions-are-supported-by-claimmd) states the API returns claim status in JSON/XML, while X12 277 is available through SFTP and 999 is not returned. Thus this inbox does not synthesize 277 or 999 transactions and does not equate status `A`, a clearinghouse receipt, payer acceptance, adjudication or payment.

The [test-account guide](https://docs.claim.md/docs/test-account-quickstart-guide) distinguishes account ownership models and says each provider-owned account needs its own key and `last_responseid`. In WardenX, this central encrypted capture currently covers the platform-owned shared account only; tenant-owned accounts remain on the established tenant-scoped polling pipeline pending a reviewed migration that avoids dual consumption.

### CM-5A.3A tenant inbox foundation

Migration 1493 and `apps/backend/src/modules/23-billing-medicare/claimmd-tenant-inbox/` add a separate tenant-owned evidence store. It uses an operator-verified internal account UUID tied to the authoritative tenant clearinghouse configuration, append-only credential-fingerprint bindings (so key rotation requires explicit confirmation but does not change account identity), encrypted source pages under that tenant's M36 DEK, and organization-scoped RLS. The operator verification reference is provenance, not a vendor-issued account identifier; the current config model does not expose a separately verifiable Claim.MD account ID. Ambiguous or unverified identity fails closed.

The typed archive-before-ACK handoff accepts the raw page already fetched by the existing tenant poller. It makes no Claim.MD request and is not yet wired into that poller. The tenant poller remains the only active tenant account reader and its legacy per-provider ACK cursors remain unchanged. Cursor inventory is read-only and deliberately does not combine incomparable ACK-type/provider coordinates into an account-level `ResponseID`. No production provisioning route, live polling activation, cursor cutover, historical backfill, or runtime PostgreSQL/RLS qualification is provided by CM-5A.3A. See [CAPTURE_FLOW.md](./CAPTURE_FLOW.md), [SECURITY.md](./SECURITY.md), and [CUTOVER_NOTES.md](./CUTOVER_NOTES.md).

## Files

- `packages/x12-837-client/src/clearinghouse/claimmd-account-response.ts` — account-wide response parser and reader.
- `apps/backend/src/modules/23-billing-medicare/claimmd-capture/` — encryption, store and one-tick capture service.
- `packages/db/migrations/1350_m23_claimmd_response_inbox.sql` and `packages/db/src/schema/billing/claimmd-response-inbox.ts` — isolated stream, encrypted page and event metadata tables.
- `architecture/module-manifest.ts` and `.cjs` — M23 table ownership; `scripts/check-tenancy.ts` — documented non-tenant-scoped tables.

## Remaining blockers

1. Confirm the account's applicable terms and mode; the public API documents the endpoint, not WardenX account authorization or retention guarantees.
2. Establish approved secret and encryption-key provisioning/rotation, platform principal binding, and stream bootstrap procedure.
3. Run private-PostgreSQL live tests for FORCE RLS, least privilege, leases/fencing, cursor atomicity, and multi-worker concurrency.
4. Before tenant-owned archival is activated, integrate the new repository through one account-scoped response owner that obtains the raw page once, archives/quarantines it with tenant-account encryption and appropriate RLS, and hands durable evidence to the existing ACK behavior without a second status-application path. The repository and typed handoff foundation exist (CM-5A.3A), but the active poller still lacks an exact raw-page seam. Reconcile the existing per-provider cursor semantics without regression or reset; only then consider a controlled tenant capture transition. Reviewed identity correlation, replay/DLQ and evidence-backed status-stage mapping remain later CM-5 work.
5. Add alerting, rate-budget coordination, retention/key recovery procedures, and staged rollout/rollback evidence.

The exact executed commands and results are in [TEST_RESULTS.md](./TEST_RESULTS.md).
