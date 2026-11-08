# Resolver runtime

## Composition

`apps/backend/src/index.ts` composes, only on a non-API worker role and only when the existing `CLAIMMD_IDENTITY_RESOLUTION_ENABLED` helper returns true:

1. Existing BIL-1.1 `claimmd_response_event`/encrypted page reader and account/environment stream scope.
2. Existing BIL-1.2 event identity extractor and deterministic matcher.
3. Concrete BIL-1.2.2B M23/M41 candidate provider.
4. Existing resolution store/history, with the Claim.MD account-wide platform role and audited bypass.
5. Existing inbox cipher, parsed from secret-manager `CLAIMMD_RESPONSE_INBOX_KEYRING`; M23/M41 historical TIN uses the existing M34 tenant DEK provider and BIL-1.2.2A evidence cipher.
6. One bounded interval runner, batch cap 25, serial processing, 60-second DB lease, no Redis dependency and no response cursor writes.

Explicit enablement fails startup on wrong vendor, absent tenant/platform DB, invalid account/usage, invalid inbox keyring, unbootstrapped account response stream, missing schema/column grants, or absent M34 key-provider seam. Missing/invalid feature flag values do not activate it. Claim.MD credentials by themselves do not activate the resolver.

## Lease, retry and replay

`claimBatch` locks due rows with `FOR UPDATE SKIP LOCKED`, assigns a lease token and version, and caps batches at 100. Runtime uses 25. Resolver writes require both expected version and active lease token, preventing a stale worker from committing after lease expiry. A single process guard avoids overlapping ticks; DB leases fence multiple replicas.

Transient failures retry with bounded exponential delay and safe codes. Eight failures move the event to `needs_review`; there is no infinite retry. Normal `unmatched`, `ambiguous`, and `needs_review` results are not hot-looped. The internal store method `requeue(eventId, expectedVersion, reason, actorId)` accepts only three safe reason values and unresolved states; resolved/conflict states cannot be reassigned. It runs under the registered audited platform job, writes immutable history/version metadata, and is not exposed through a tenant route.

## Observability

The tick log includes only counts (processed/failed and pending/resolved/unmatched/ambiguous/conflict/review) and oldest unresolved age. It omits account, tenant, patient, claim, vendor payload, TIN, NPI and raw errors. This first slice does not yet export a dedicated Prometheus metric family or alert on age/retry thresholds; that is a rollout operations gap.

The worker consumes only rows already in BIL-1.1 inbox. It does not perform Claim.MD requests, create streams, move the authoritative cursor, apply acknowledgments, or mutate claims.
