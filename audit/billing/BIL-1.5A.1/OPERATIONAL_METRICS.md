# Operational Metrics and Readiness

`apps/backend/src/bootstrap/claimmd-operational-metrics.ts` registers fixed-label counters and gauges on the existing Prometheus registry. Worker labels are a closed union (`response_capture`, `identity_resolution`, `ack_dispatch`, `era_capture`, `era_resolution`, `era_delivery`); outcomes are `success`/`failure`; gauge dimensions are fixed measure names. No account, tenant, patient, provider, ERA, claim, payment reference, payload, or vendor error is used as a label.

The composition root records summaries emitted by response capture, identity resolution, acknowledgment dispatch, ERA capture, ERA ownership resolution and ERA delivery. Structured worker logs continue to carry aggregate summaries and safe codes.

## Incomplete coverage

These metrics are tick-derived counters/latest summaries. The implementation does not yet sample durable DB state for response inbox backlog, cursor age, oldest unresolved response, lease contention, ERA stage counts, oldest undelivered ERA, duplicate posting attempts, financial identity conflicts or manual-review backlog. Nor does it add Claim.MD-specific `/ready` dependency checks. These are blockers before operational certification.

Existing enabled-worker startup preflights remain fail-closed for account configuration, keyring, DB schema/bootstrap, worker role and shared rate limiter. Disabled workers are not required for unrelated app startup. No readiness check sends Claim.MD traffic.

## Alert guidance

Until durable samplers are added, alert on repeated worker `failure` ticks and sustained nonzero aggregate backlog via the existing Prometheus/Pino pipeline. BIL-1.5A.2/1.5B should set numeric thresholds after private DB and test-account behavior are measured; avoid paging on one transient tick. Add dedicated alerts for cursor staleness, lease contention, retry exhaustion, ownership conflict, duplicate hold, keyring failure and manual review age when durable metrics exist.
