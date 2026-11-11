# BIL-4.4 — Provider Adjustments & Recovery Review

## Result

Implemented source-preserving, tenant-scoped, **nonposting** review of Claim.MD ERA provider-level adjustments (PLB), including signed balance presentation and an auditable follow-up decision. The Claim.MD posting plan now exposes the PLB facts and blocks the full ERA when provider adjustments lack an authorized policy. No new migration or financial posting action was added.

The worktree was already dirty with BIL-4.1–4.3 changes. Those changes were preserved. See [PostgreSQL and financial tests](POSTGRESQL_FINANCIAL_TESTS.md) and [remaining blockers](REMAINING_BLOCKERS.md).

## Boundaries

- PLB data is provider-level source evidence; no claim allocation is inferred.
- A balanced ERA is not posting authorization or bank settlement evidence.
- No PLB, reversal, recoupment, refund, write-off, patient billing, or automatic posting was enabled.
- `CLAIMMD_ERA_CONTROLLED_POSTING_ENABLED` remains disabled by default.

## Documents

- [Policy governance](FINANCIAL_POLICY_GOVERNANCE.md)
- [Legacy CO/PI review](LEGACY_CO_PI_AUTHORIZATION_AUDIT.md)
- [PLB source and balancing](PLB_SOURCE_AND_BALANCING.md)
- [Reversal and recovery evidence](REVERSAL_AND_RECOVERY_EVIDENCE.md)
- [Review audit](EXCEPTION_REVIEW_AND_AUDIT.md)
- [Posting safety](POSTING_ELIGIBILITY_AND_SAFETY.md)
- [API/UI](API_AND_FRONTEND.md)
- [PostgreSQL and tests](POSTGRESQL_FINANCIAL_TESTS.md)
- [Regression limits](NON_REGRESSION.md)
- [Next phase](NEXT_PHASE_READINESS.md)
