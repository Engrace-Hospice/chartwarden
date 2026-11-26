# Observability gap analysis

| Required signal | State | Result |
|---|---|---|
| Upload-to-processing latency | Timestamps exist across upload/batch/job, but no dedicated metric | FAIL |
| Queue waiting time | BullMQ exposes timestamps, but no duration histogram | FAIL |
| Parsing failures | Failed queue job retained; batch has no failure state and logs lacked a structured failed-run record | FAIL |
| Classification failures | Job failure reason exists after job creation; no dedicated counter/alert found | FAIL |
| Extraction failures | Same as classification | FAIL |
| Awaiting-capability jobs | Database status exists; no metric/alert found | FAIL |
| Stalled processing | BullMQ stalled/failed state available; WardenLens queue was absent from generic metrics | FAIL before correction |
| Review backlog | `intake_upload_batch` query/index exists; no gauge found | FAIL |
| Retry attempts | BullMQ attempts exist and failed/delayed queue counts become visible with this branch's correction, but no attempt counter/alert exists | FAIL |
| Worker availability | Worker readiness exists; no WardenLens-specific availability alert/metric found | FAIL |

Corrective change: the canonical `m22-doclens-intake` queue is now included in
`chartwarden_bullmq_queue_jobs`, exposing waiting, active, completed, failed, and delayed counts without
PHI or high-cardinality batch labels. A unit test proves late-bound queue names are included and
deduplicated.

Successful-run WardenLens logs contained organization ID, batch ID, correlation ID, and counts/status
summary only. However, a failure-path Better Auth dependency log printed a raw session-token query
parameter before Fastify's safe error serializer ran. This is a confirmed FAIL. The branch disables
that duplicate dependency logger and adds a config regression test; runtime failure-path revalidation
remains required. Alert definitions for the other gaps were not present, so those items remain FAIL.

