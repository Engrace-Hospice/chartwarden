# 18 — Production blockers

## Immediate blockers

| Finding/gate | Why it blocks |
|---|---|
| CW-QA-0001 | Runtime path can misclassify primary payer and assemble an invalid Medicare claim basis. |
| CW-QA-0002 | Production artifacts can release/deploy without the full verification suite. |
| CW-QA-0013 | Repository evidence says production has no object-store backup/coordinated restore. |
| CW-QA-0017 | Automatic rollback can activate old code on an unverified advanced schema. |
| Biome/lint | Current authoritative gate fails. |
| Full E2E/accessibility | Blocked; critical dynamic/admin/portal/manual surfaces unverified. |
| Full clinical/billing lifecycle | Only targeted live subsets were executed. |
| Performance/load | Bundle budgets fail; backend/queue/database load was not tested. |

## Conditional release criteria

1. Correct payer intervals and range-wide cross-kind resolution; prove no claim row is committed on
   ambiguity.
2. Restore mandatory debounced CI-before-release and make lint green or explicitly ratcheted.
3. Implement and independently restore coordinated DB/object backups with full RLS/object checks.
4. Enforce migration compatibility or halt automatic rollback when schema advanced.
5. Complete isolated browser, accessibility, failure, and load gates for critical workflows.

Until these are met, the production decision remains **NOT_READY**.
