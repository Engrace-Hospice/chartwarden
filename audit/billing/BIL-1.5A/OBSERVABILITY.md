# Operational observability

Response capture emits PHI-safe aggregate counters and fixed failure codes. It does not yet expose the full required operator metrics/readiness surface (backlog age, oldest unresolved event, lease contention, resolution outcomes, delivery exhaustion, and financial review backlog). Do not treat boot logs as a health certification. Implement metric gauges/counters and alert thresholds in a follow-up before activation; do not include raw vendor errors, payloads, patient identifiers, NPI/TIN, or credentials.
