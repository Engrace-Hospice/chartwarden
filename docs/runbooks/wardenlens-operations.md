# WardenLens operations

WardenLens telemetry is deliberately aggregate-only. Do not add organization, patient, referral,
document, batch, candidate, prompt, extracted value, object URL, authorization value, or raw error text
to metrics or alert annotations.

## Worker unavailable

Confirm the worker process `/ready` response, Valkey reachability, and the
`m22-doclens-intake` worker registration. Drain or restart only after checking whether an active job is
still within its lock duration. A restart must rely on the idempotent batch/job state; never edit a
clinical row to make a job appear complete.

## Queue wait or stalled processing

Inspect aggregate queue counts and the worker/Docling resource envelope. For an exhausted batch, use
the authenticated extraction-run route to retry after the dependency is healthy. Do not delete BullMQ
keys or reset a batch directly in PostgreSQL. A discarded batch must remain discarded.

## Processing latency

Compare queue wait with upload-to-processing latency. Queue-only growth points to worker capacity;
active processing growth points to Docling or governed-model latency. Check CPU/memory saturation and
provider health without logging document contents or presigned URLs.

## Processing failures

Use the bounded `stage` label to choose the dependency to inspect. The batch API exposes only the
sanitized terminal code and attempt count. Correlate through the protected audit interface; do not put
raw dependency exceptions into logs or alert payloads. Retry only after the failed dependency recovers.

## Awaiting capability

Verify the tenant feature flag, local-only opt-in, capability lifecycle, exact model pin, backend health,
and remaining budget. Restore configuration through the governed AI administration path. Never bypass
the capability registry or insert fabricated invocation rows.

## Review backlog

Confirm reviewer staffing and whether identity or Part 2 safeguards are holding reviews. Reassignment
must use the authorized workflow. Do not bulk-approve medium/high-risk, identity-unresolved, or Part 2
candidates to reduce the backlog.
