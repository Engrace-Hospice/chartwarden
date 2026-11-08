# Worker fencing and crash recovery

**Status: BLOCKED for the requested multi-worker certification.**

The M23 inbox live test ran two independent PostgreSQL connections concurrently against an expired stream lease and observed exactly one SQL winner (one inserted result, one fenced result). It passed as part of the 3/3 `m23-claimmd-response-inbox.live.test.ts` run. This is a narrow SQL assertion; it did not run two worker processes or prove cursor movement, stale generation rejection, restart idempotency, or capture-after-persistence crash behavior.

No multi-process tests were executed for identity resolution, acknowledgment delivery, ERA discovery, ownership, or M25 staging delivery. No process kill/crash points were injected. The previous Phase 1 report's delivery regressions and migration restart tests remain separate evidence and were not repeated.

Phase 1.2 must use separate worker processes (or independently isolated worker runtimes and connections), deterministic barriers/failure points confined to tests, and inspect durable rows after restart. A pair of sequential service calls is insufficient.
