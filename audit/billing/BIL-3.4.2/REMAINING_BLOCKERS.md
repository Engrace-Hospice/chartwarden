# Remaining blockers

1. **Critical — source/transaction mismatch:** Claim.MD's encrypted staged ERA and BIL-3.3 decisions are separate from `remittance_advice` consumed by `postAdvice`. `postAdvice` owns its transaction and auto-matches independently. Extract a transaction-level M25 posting core that receives a server-validated plan, explicit match decisions and transaction context; preserve the legacy wrapper behavior.
2. **Critical — no immutable plan/approval:** there is no durable plan version or distinct approver record bound to exact source and match revisions.
3. **Critical — no actual posting API/UI:** no explicit authorized execution endpoint or usable approval/execution UI exists.
4. **High — accounting integration tests:** no real PostgreSQL ledger posting/rollback/idempotency/concurrency test can pass until items 1–3 exist.
5. **High — line matching:** M25 still does not consume BIL-3.4's attempt-specific line evidence; keep line allocation blocked where required.

No accounting rule was bypassed and no Claim.MD financial effect was enabled.
