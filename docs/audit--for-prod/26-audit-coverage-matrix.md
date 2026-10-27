# 26 — Audit coverage matrix

| Area | Inventory/static | Automated | Runtime | External/operational | Final status |
|---|---|---|---|---|---|
| Workspace/config/toolchain | Complete | install/build/typecheck | n/a | n/a | Audited |
| All 41 modules | Manifest/spec/code mapped | status/fitness | targeted subset | vendors blocked | Audited statically; runtime exceptions named in report 00 |
| Frontend routes/screens | 381 generated inventory | coverage reports/builds | blocked | manual a11y blocked | Partial/blocked |
| Backend endpoints | OpenAPI + registrar inventory | 43 fitness gates | targeted APIs/live paths | exhaustive BOLA blocked | Partial |
| Database/migrations | schema/603 migrations/RLS | replay + baseline RLS | isolated PostgreSQL | production stats blocked | Strong partial |
| Authentication | code/config | unit + targeted live | core/hardening/auditor | IdP operations unavailable | Targeted pass |
| Authorization/tenant isolation | guards/ABAC/RLS | gates + baseline live | selected | penetration test blocked | Partial |
| Clinical lifecycle | all owning modules traced | unit/live presence | M6/HOPE subset | real clinical practice blocked | Partial |
| Medicare billing | M23/M5/M6/M25 traced | targeted 129+83 | payer repro confirmed defect | MAC blocked | Fail |
| Medicaid/commercial | M24/M41/M25 traced | repository tests/select live | limited | payers/states blocked | Partial |
| HOPE/CMS | code/spec/docs + current CMS | targeted 61 | local DB | iQIES blocked | Fail policy issue |
| Integrations | adapters/queues/contracts | fitness/tests | no real partners | blocked | Unverified externally |
| Security/privacy | auth/RLS/secrets/data flow | advisories/gates/live RLS | no exploit campaign | pen test/ops blocked | Partial |
| Performance | bundle artifacts | size checks | no load/browser timing | telemetry blocked | Fail/blocked |
| Reliability/queues | code/config | queue/outbox gates | selected workers only | load/failure blocked | Partial |
| DevOps/supply chain | workflows/compose/images | scans/config checks | no prod deploy | host controls blocked | Fail |
| Backup/DR | docs/scripts/drill artifact | demo verifier | demo M36 evidence | production evidence absent | Fail |
| Tests themselves | configs/suites/reports | full non-live + target live | order defect reproduced | full matrix blocked | Partial |
| Documentation drift | corpus/generated reports | doc gates | n/a | n/a | Findings retained |

Every discovered module appears in report 00. “Runtime unverified here” is deliberate and prevents
the structural implementation matrix from being mistaken for a production-readiness certification.
