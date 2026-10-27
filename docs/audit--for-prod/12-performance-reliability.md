# 12 — Performance and reliability

## Measured

- Web entry: 562.90 kB raw/171.02 gzip; budget failure.
- Admin entry: 590.99 kB raw/171.92 gzip; budget failure.
- Portal entry: 395.08 kB raw/120.21 gzip; checker falsely measured zero.
- No browser timings, backend latency/throughput, memory, CPU, queue depth, or database query plans
  were measured because no representative isolated stack/dataset existed.

Findings: `CW-QA-0004`, `CW-QA-0005`, and `CW-QA-0012`.

Reliability controls present include health checks, typed failure envelopes, BullMQ retry/DLQ
catalogs, idempotency ledgers, outbox processing, graceful behavior for unavailable Docling/ClamAV,
and post-deploy smoke logic. Architecture gates validate names/bindings, not actual crash recovery,
poison-message isolation, backlog alerting, or failure duration.

Required next tests: concurrent clinical/billing users, large patient/claim lists, multi-tenant
bursts, OCR/attachment load, queue recovery, cache/database outages, network interruption, expired
vendor credentials, worker kill/restart, duplicate webhook delivery, and stale frontend/API
compatibility. All must use synthetic data and isolated infrastructure.
