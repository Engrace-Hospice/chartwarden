# BIL-4 capability matrix

| Phase | Verified source capability | Evidence / boundary |
|---|---|---|
| 4.1 | One or multiple fully paid M41 claims in one immutable approved plan; aggregate balancing, transaction posting, duplicate/concurrency protections | `audit/billing/BIL-4.1/POSTGRESQL_FINANCIAL_TESTS.md`; private suite rerun this closeout (M25 ingestion 50/50) |
| 4.2 | Narrow OA partial case: payer payment is recorded; OA residual is flagged for review; no patient receivable or write-off | `audit/billing/BIL-4.2/POSTING_PLAN_AND_EXECUTION.md`; private suite rerun (50/50 M25 ingestion) |
| 4.3 | CO/PR/PI facts are preserved/classified; unsupported policy effects are blocked; OA behavior retained | `audit/billing/BIL-4.3/POSTING_PLAN_AND_LEDGER_EFFECTS.md`; assessment and DB coverage documented in phase reports |
| 4.4 | PLB facts and signed amounts are visible in a nonposting review; recovery relationships and posting remain blocked | `audit/billing/BIL-4.4/PLB_SOURCE_AND_BALANCING.md`; private runner rerun as part of this closeout |
| 4.5 | M23-owned attempt evidence feeds M25 review; source charge comes from immutable submitted-line evidence; Medicare plan is blocked | `audit/billing/BIL-4.5/M23_TO_M25_ERA_INTEGRATION.md`; added negative execution boundary passed in this closeout |

The matrix describes implemented supported scope, not universal payer accounting support. Medicare posting, CO write-offs, patient billing, PLB/recovery posting, reversals and recoupments remain unavailable.
