# Remaining blockers

- No durable worker heartbeat exists; the API reports it unavailable.
- No durable read contract exposes current rate-budget usage or remaining requests.
- Cursor advancement time is not separately persisted from polling activity.
- The restricted central endpoint has no dedicated platform UI yet.
- A combined central Fastify-to-platform-PostgreSQL integration test remains to be added.
- No SLA thresholds were invented; age/status policy requires an approved operational policy.
