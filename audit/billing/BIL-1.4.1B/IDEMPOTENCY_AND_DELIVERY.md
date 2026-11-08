# Idempotency and delivery

## Identities

- Account receipt key: SHA-256 of `claimmd`, account reference, usage (`test`/`production`), and ERA ID, matching the account-scoped vendor identity.
- Tenant component key: SHA-256 of the receipt key, source file index, and 835 transaction-set control number.
- Database constraints enforce unique account/vendor/environment/ERA, inbox, central key, and tenant component key.

## Handoff and recovery

The central ledger transitions to `prepared`; M25 creates each tenant row held under tenant RLS; the central receipt records final disposition and stage IDs; only then does M25 transition rows to review-eligible/duplicate/held. These are separate central and tenant transactions by design. A crash between them is recovered by polling `prepared`/not-finalized rows and replaying the same component key. A crash after tenant insert is resolved by the tenant uniqueness check and existing-row validation. The system does not claim cross-database atomic commit; recovery semantics are the substitute and require private-PostgreSQL concurrency certification.

Central ledger/history mutations run under audited `withPlatformContext` using `CLAIMMD_ERA_DELIVERY_JOB_ID`. Tenant writes use `withOrgContext`. Existing capture cursors are not modified.

## Staleness and retry

Before staging, delivery verifies the source digest through the capture store, checks current resolution ID/version/owner/algorithm, and checks append-only resolution history. The central prepare and finish transactions recheck source and resolution under row locks. A stale owner/version is held; no owner reassignment is allowed. Automatic prepared retries are bounded at 10 attempts. There is no operator requeue endpoint/service in this phase; exhausted work requires a separately authorized audited recovery mechanism before activation.

## Cross-source classifier

`claimmd-era-duplicate.ts` treats same raw transaction-set digest plus ISA/ST controls as exact, reused controls or same TRN+amount as possible, and otherwise distinct. Amount/date alone are not duplicate evidence. Existing M25 comparison is bounded. A possible match remains held. This does not provide universal cross-source posting idempotency across every legacy channel and must not be described as such.
