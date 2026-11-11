# Legacy CO/PI Authorization Audit

Inspected `apps/backend/src/modules/25-remittance/domain/classify.ts::routeAdjustment`, `service-drizzle.ts::postAdjustments`, and `remittance-commands-drizzle.ts::overrideAdjustment`.

| Operation | Conditions/evidence | Observed effect | Authorization/evidence gap |
|---|---|---|---|
| Route mapped CO/PI adjustment | Existing legacy 835 classification mapping | `auto_posted` action classification is persisted with the remittance adjustment | The label alone does not establish an AR write-off or payer reduction |
| Post legacy remittance | Existing manual/SFTP path and its existing posting guards | Persists remittance/payment and adjustment records; transactional/outbox behavior remains legacy-owned | No new policy semantics are inferred by this phase |
| Override adjustment | Existing command permission/guard and audit path | Changes action classification and records audit evidence | This phase found no separate write-off ledger mutation in the override operation |

Source review found no direct write-off/AR ledger row or write-off event created by `auto_posted` or the override command. This is a bounded source inspection, not proof of every asynchronous downstream consumer. Existing behavior was left unchanged; expanding Claim.MD behavior remains blocked absent an approved policy.
