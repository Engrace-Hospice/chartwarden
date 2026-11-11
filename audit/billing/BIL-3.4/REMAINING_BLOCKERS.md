# Remaining blockers

1. **Critical — M25 posting boundary:** no approved-plan-bound route from Claim.MD staged ERA/matching decisions to the existing ledger transaction. Implement a domain operation that validates plan, approval, tenant/provider scope, source freshness, duplicate-effect identity, and posting permission atomically before reusing `postAdvice` semantics.
2. **High — service-line matching:** M25 does not yet resolve 835 lines to attempt-specific evidence or record verified/ambiguous outcomes.
3. **High — authorization/UX:** no separate posting approval/executor workflow or financial posting UI exists.
4. **High — database certification:** migration 1396, RLS and real-role behavior were not run on isolated PostgreSQL.
5. **High — line reference capability:** current renderers do not add REF*6R; payer/vendor echo behavior is unverified. Do not assume it.
6. **High — ledger scenarios:** idempotency across Claim.MD/manual/SFTP, concurrent posting, reversals, PLB, recoupments, and rollback are not certified by this phase.
