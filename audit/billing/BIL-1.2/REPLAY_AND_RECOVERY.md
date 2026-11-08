# Replay and recovery

- Migration 1351 backfills one `pending` metadata row for every already-captured BIL-1.1 event and installs an after-insert trigger so new captured events enter the resolution queue in the same transaction. It does not alter the response cursor or payload.
- `claimBatch` uses `FOR UPDATE SKIP LOCKED`, bounded rows, owner UUIDs, and expiry-based leases. A stale worker cannot retain work forever; another worker may reclaim after lease expiry. The implementation is inactive until its internal principal and job registration are bound.
- Resolution uses optimistic `version` checks. `(event_id)` is unique, and history has `(resolution_id,version)` uniqueness. Re-running a resolved event with the same target is idempotent. New contradictory evidence creates a conflict and preserves the prior target for review rather than silently assigning another tenant.
- Unmatched, ambiguous, and needs-review records get a retry time. The worker turns transient exceptions into a fixed safe code; no exception text, TIN or response payload is stored/logged. Resolution rows and source inbox pages are not automatically deleted.
- The worker's repository contract uses `claimBatch`, `complete`, and `retry`; one-tick batch size is capped at 100. Retries currently use a simple fixed delay in the concrete store, not exponential jitter. Production scheduling, dead-letter alerting, manual requeue, and operator audit flow remain unwired.
- Controlled re-evaluation can be performed by updating the safe internal record to `pending` through a future audited administrative procedure after source evidence repair. No general-purpose manual tenant assignment endpoint exists.

## Historical backfill

The migration backfills resolution metadata only. It does not backfill vendor IDs, NPI/TIN snapshots, or account/environment onto old submission records. Such events are processed only if an independently verifiable historical candidate exists; otherwise they remain unresolved. Never use the current provider profile to fabricate an old send identity.
