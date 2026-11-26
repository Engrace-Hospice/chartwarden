# Confirmed defects and readiness score

## Confirmed defects and readiness gaps

1. **High readiness gap (BLOCKED validation) — production-equivalent full-packet capacity is unproven.** The 21-page synthetic packet
   caused the isolated dev-stack Docling container to exit 137. Production declares a different 2 GiB/2 CPU
   envelope; rerun there before attributing the failure to production capacity. Source path:
   `apps/backend/src/modules/22-documents/extraction/intake-job.ts`.
2. **High — exhausted parsing failures are not projected to the batch.** BullMQ retained a failed job
   after 3 attempts, but the batch stayed `uploaded`, and the batch jobs API showed no extraction job.
   Source paths: `extraction/intake-queue.ts`, `extraction/intake-job.ts`.
3. **High — concurrent control-plane degradation was observed but not isolated.** During the large
   parse interval, API session reads hit PostgreSQL connection timeouts and BullMQ repeat jobs lost
   locks. The evidence establishes temporal correlation, not root cause.
4. **Medium — newly seeded tenant lacked its object bucket.** Presign succeeded but PUT returned 404
   until `scripts/backfill-tenant-buckets.ts` created it. Production onboarding must prove M34 bucket
   provisioning before enabling uploads.
5. **Medium — WardenLens queue metrics were absent.** `allWorkers` was sampled before the DocLens
   worker was constructed. Corrected on this branch in `apps/backend/src/index.ts`.
6. **Medium — operational readiness omits Docling/AI/WardenLens.** `/ready` reports database, Valkey,
   object store, outbox, and unrelated capability flags, but no Docling reachability, governed AI
   backend availability, or WardenLens worker heartbeat.
7. **Medium — required operational signals have no metrics/alerts.** Upload latency, queue wait,
   awaiting capability, review backlog, and WardenLens-specific worker availability remain absent.
8. **High — dependency failure logging exposed a bearer session token.** Better Auth's default logger
   printed the Drizzle session-query parameter before Fastify's credential-safe serializer handled the
   request error. Corrected on this branch by disabling the duplicate dependency logger; a regression
   test pins that configuration. Runtime failure-path revalidation is still required.

## Score

| Category | Weight | Score | Basis |
|---|---:|---:|---|
| Environment/dependencies | 15 | 10 | Core services work; bucket failure and production-equivalent Docling capacity BLOCKED. |
| Isolated PostgreSQL/live controls | 10 | 10 | F236 13/13 and F237 16/16 on separately proven clusters. |
| Governed AI integration | 20 | 16 | Real pinned calls, encrypted ledgers, tokens/budgets; large packet and real writeback incomplete. |
| Referral-to-admission acceptance | 20 | 16 | One-page path through pending admission passed; approved chart writeback BLOCKED. |
| Failure/recovery | 15 | 6 | Redis visibility/recovery passed; Docling recovery failed; most injections BLOCKED. |
| Observability | 10 | 3 | Queue counts corrected; most required signals and alerts absent. |
| Security/compliance | 10 | 6 | Strong isolation/encryption/HITL; dependency log exposure corrected but not runtime-revalidated; provenance and positive real SUD/writeback evidence incomplete. |
| **Total** | **100** | **67** | **NOT READY** |

Production exit criteria: pass the 21-page packet within documented resource limits; project terminal
worker failures into visible/retryable batch state; demonstrate actual low-risk approved writeback plus
provenance; execute the remaining failure matrix; and add/alert on the missing operational signals.

