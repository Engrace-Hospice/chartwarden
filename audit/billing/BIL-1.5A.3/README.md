# BIL-1.5A.3 — Platform Recovery Operability & Durable Monitoring

## Result

**Source readiness: CONDITIONAL GO for BIL-1.5B cumulative validation.** The existing ERA recovery service is now reachable through a platform-only, authenticated, step-up protected operation. Prometheus scrape-time gauges now include bounded aggregates read from durable response, acknowledgment, ERA and M25 state. The capability section of `/ready` reports each pipeline as `disabled`, `ready` or `degraded`; worker startup still enforces dependencies when a flag is explicitly enabled.

No Claim.MD worker, notice transmission, or financial posting was enabled. No live vendor request, production migration, deploy, or PostgreSQL runtime certification was performed. Metrics and route tests are source-level evidence, not proof of PostgreSQL RLS, transaction isolation, multi-worker behavior, or vendor behavior.

## Scope and evidence

- Recovery endpoint and authentication: [PLATFORM_ERA_RECOVERY.md](PLATFORM_ERA_RECOVERY.md), [OPERATOR_AUTHORIZATION.md](OPERATOR_AUTHORIZATION.md).
- Durable aggregate metrics and their coverage limits: [DURABLE_OPERATIONAL_METRICS.md](DURABLE_OPERATIONAL_METRICS.md).
- Startup prerequisites and flags: [PIPELINE_READINESS.md](PIPELINE_READINESS.md), [LEGACY_WORKER_COMPATIBILITY.md](LEGACY_WORKER_COMPATIBILITY.md).
- Verification: [TEST_RESULTS.md](TEST_RESULTS.md).
- Deferred items for BIL-1.5B: [REMAINING_BLOCKERS.md](REMAINING_BLOCKERS.md), [BIL_1_5B_HANDOFF.md](BIL_1_5B_HANDOFF.md).

## Implementation status

| Component | Status | Source-level result |
|---|---|---|
| Platform ERA recovery invocation | Implemented | Authenticated operator identity, M23 platform-admin permission, fresh step-up, configured account/environment binding, strict request validation, and call to the existing recovery service. |
| Recovery transition safety | Implemented, DB certification pending | Existing store action ID, row locking, expected state/version, bounded retry and append-only action record are used; no cursor or financial state is changed. |
| Durable response/ack metrics | Implemented, DB certification pending | Read-only audited aggregate reader; no payload decryption or business identifiers as labels. |
| Durable ERA metrics | Implemented, DB certification pending | Store aggregates stream/capture/resolution/delivery states without decrypting 835. |
| Financial review aggregates | Partial | M25 organization-scoped parse and unmatched-line counts are aggregated; source-wide duplicate-attempt and posting-guard-failure history is not independently durable. |
| Pipeline readiness | Partial | Existing enabled-worker constructors perform fail-closed dependency/schema/bootstrap preflights; `/ready` adds capability states but is not a complete independent dependency probe for every pipeline. |
| Legacy/new worker coordination | Partial | M23 legacy Claim.MD polling is guarded against capture/dispatcher overlap; M41 Claim.MD legacy ack reader already short-circuits. Cross-version rolling deployment still requires quiescence. |

## Release boundary

BIL-1.5B can begin cumulative validation. All controlled-test activation decisions remain **NO** pending private PostgreSQL, authorization/RLS and synthetic vendor-account certification. Production activation and automatic posting remain **NO**.
