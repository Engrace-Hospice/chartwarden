# Remaining Blockers

| Severity | Component | Evidence/status | Required correction |
|---|---|---|---|
| P1 | ERA recovery operability | Store/service exist, but `apps/backend/src/index.ts` does not compose the recovery service and no privileged platform operations route or CLI invokes it. | Add a platform-ops permission + ABAC + step-up protected operation or established internal CLI, with end-to-end authorization tests. Keep tenant APIs excluded. |
| P1 | Financial concurrency certification | PostgreSQL scenarios are added to `m25-835-ingestion.live.test.ts`, but DB URL was absent; advisory lock behavior and final state remain unproven. | Run on private disposable PG with the application role and inspect final advice/line/outbox state. |
| P1 | Financial path inventory | `postAdvice` contains common guard, but broad source-path evidence for all manual/SFTP/import jobs is not complete in this sub-phase. | BIL-1.5B trace all producers to the common service and add cross-source fixtures. |
| P1 | Durable operations visibility | Added worker tick metrics do not cover durable cursor age, lease contention, oldest backlog, duplicate holds or manual review age. | Add bounded aggregate samplers/readiness and alerts before controlled activation. |
| P1 | Runtime certification | Claim.MD account, credentials, keyring, schema grants, leases and rate limiter not exercised. | BIL-1.5B private DB and approved synthetic test-account certification. |
| P1 | Medicare notices | Immutable evidence remains claim-only for NOE/NOTR/Transfer. | BIL-1.5A.2 narrow evidence compatibility correction and tests. |
| P2 | Migration sequencing | Migration 1360 is additive `expand`; migration 1358 remains `contract` and must preserve its documented sequencing. | Apply only through approved staged release/migration process; test compatibility in private PostgreSQL. |
