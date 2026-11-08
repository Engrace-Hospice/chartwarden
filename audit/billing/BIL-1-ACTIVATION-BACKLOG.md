# BIL-1 activation backlog

This list tracks release and activation certification that remains deferred from integration into the non-deploying `develop` branch. **Deferred does not mean waived.** No Claim.MD worker, hospice notice transmission, or automatic financial posting is enabled by this integration.

| Area | Status | Required before controlled/production activation |
|---|---|---|
| Two-tenant Claim.MD response certification | Pending | Exercise encrypted response capture, actual M23/M41 candidate resolution, approved acknowledgment application, and persisted tenant/status/ledger outcomes. Include collision and ambiguity cases. |
| Two-tenant Claim.MD ERA certification | Pending | Run synthetic 835 discovery/capture, ownership, duplicate review, M25 staging and authorization; assert no payment, adjustment, AR, balance or posting-outbox effects. |
| Worker concurrency and crash recovery | Pending | Independent workers/processes, lease fencing, cursor fencing, crash/restart and idempotence across response, resolution, dispatch, ERA discovery, ownership and delivery. |
| Authenticated platform recovery | Pending | Actual auth plugin → permission/ABAC/step-up → route → PostgreSQL recovery/audit; denial, idempotency, stale/concurrent request and no-posting assertions. |
| Live Claim.MD test-account certification | Pending | Confirm approved test credentials, endpoint authorization, synthetic fixtures and behavior for `/services/response/`, `/services/eralist/`, `/services/era835/`, `/services/eradata/`; no patient data. |
| Hospice notice vendor capability | Pending | Written vendor confirmation and transaction-specific test certification before enabling NOE/NOTR/Transfer transmissions. |
| Legacy worker cutover | Pending | Confirm mutually exclusive M23/M41 response and M25 ERA modes across rolling deployments; define quiescence, cursor continuity and rollback/forward-fix procedure. |
| Production PostgreSQL/RLS and concurrency | Pending | Isolated production-version database; populated migration upgrade, real app/platform roles, FORCE RLS, financial concurrency, recovery and multi-worker tests. Never use shared `os-postgres-1`. |
| Production deployment and migration rehearsal | Pending | Disposable rehearsal for migrations 1353/1358 contract handling, interrupted startup, operator hold and forward recovery. |
| Operational metrics and alerts | Pending | Validate durable backlog/cursor/retry metrics, PHI-safe labels, readiness checks, alert thresholds, keyring and lease failures, and operational recovery runbook. |
| Independent review and CI | Pending | Reconstruct the intended PR stack, pass required CI, complete security/code review, and resolve historical PR state. Do not treat this backlog as merge approval. |

## Safety state

- Response capture: disabled by default; controlled activation not certified.
- Identity resolution: disabled by default; controlled activation not certified.
- Acknowledgment dispatch: disabled by default; controlled activation not certified.
- ERA discovery/capture and ownership resolution: disabled by default; controlled activation not certified.
- M25 Claim.MD staging delivery: disabled by default; controlled activation not certified.
- Hospice notice transmission: disabled pending vendor capability confirmation.
- Automatic financial posting from Claim.MD staging: prohibited and not enabled.
- Production activation and deployment: not authorized by this development integration task.
