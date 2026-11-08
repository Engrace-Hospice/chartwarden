# Durable operational metrics

`apps/backend/src/bootstrap/claimmd-operational-metrics.ts` registers bounded Prometheus series. A lazy sampler runs at scrape time and caches successful results for 30 seconds. Concurrent scrapes share an in-flight sample. Failures set `chartwarden_claimmd_durable_metrics_read_success` to `0`; safe fixed labels prevent identifiers or vendor text from becoming labels. Existing process-local worker tick counters remain separate from durable state.

Durable readers use aggregate state/count/minimum-time queries and do not decrypt inbox payloads. The response/ack reader uses audited platform context for the account/environment stream. The ERA store aggregates central capture/resolution/delivery state. Financial summaries query M25-owned organization rows under each organization context, with bounded chunks and a statement timeout on organization enumeration; tenant IDs are not labels.

Current measures include cursor presence/age and last success, stream error and lease state, response capture/resolution/ack state counts, unresolved/oldest age, ERA capture retry failures/exhaustion, ownership and delivery states/age, and M25 held/failed/unmatched review counts/age.

## Coverage limits

The metrics are snapshots, not a durable historical time series. Historical trend/alert windows belong to Prometheus. Current source does not independently persist every requested event counter (for example, all duplicate-posting attempts, every posting guard failure, and every lease contention event). Those signals must not be inferred from a zero-valued aggregate. The financial reader currently summarizes M25 parse/review state, not every cross-source import attempt. The response/ERA readers are unexecuted against PostgreSQL in this phase. Any sampler failure currently fails that scrape's durable sample as a whole; this is visible via the read-success gauge but not separately attributed by PHI-bearing error labels.

## Alert guidance

Use bounded worker/measure labels only. Suggested initial alerts for BIL-1.5B to tune against real workload: cursor age above the agreed polling interval for 2 consecutive samples; oldest unresolved/undelivered age above the operational SLA; any retry-exhausted or ownership-conflict count above zero; durable sample health below one for 3 minutes; and rising held duplicate/unmatched review counts. Do not alert with patient, claim, ERA, TIN, NPI, PCN or payment trace values.
