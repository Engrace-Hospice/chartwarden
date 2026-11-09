# BIL-2.2 — Medicare submission lifecycle

## Result

The registered M23 837I submit and retry workers now execute preparation and finalization in short organization-scoped transactions. Their external transport call runs after the preparation transaction has committed. A durable dispatch reservation is written before transport, and an uncertain result remains non-retryable until the vendor attempt can be reconciled. The original immutable reviewed-source fingerprint remains on the attempt.

Existing replacement and void flows remain append-only claim chains (TOB 817/818). The claim submission history now distinguishes a queued attempt from one actively sending or awaiting reconciliation. No Claim.MD request, production migration, deployment, worker activation, or financial posting was performed.

## Limitations

- Migration 1379 is `compat: contract`: deploy the code and schedule the contract migration in a reviewed maintenance sequence; do not let an old worker run against the new enforcement trigger.
- A crash in the legacy MAC portal path has no remote attempt store for deterministic reconciliation; the durable `sending` state prevents retransmission but requires operator review.
- The M23 worker lifecycle passed a targeted private PostgreSQL 18 suite (5/5); separate-process crash recovery, broader RLS and cumulative claim workflow certification remain pending.
- BIL-2.3 remains the next phase; this phase does not authorize Claim.MD or production activation.

See [worker lifecycle](SUBMISSION_WORKER_LIFECYCLE.md), [retry/recovery](TRANSPORT_RETRY_AND_RECOVERY.md), [history/UI](SUBMISSION_HISTORY_AND_STATES.md), and [readiness](NEXT_PHASE_READINESS.md).
