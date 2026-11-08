# Remaining blockers

| Severity | Component | Blocker | Required evidence/correction |
|---|---|---|---|
| P1 | Claim.MD hospice notice support | No vendor-specific confirmation that NOE, NOTR and transfer notice 837I submissions are accepted and routed correctly | Written Claim.MD support/contract confirmation and approved synthetic test-account cases before enabling the notice flag |
| P1 | Notice acknowledgments | BIL-1.3 resolver/dispatcher remains claim-specific; no verified notice response mapping | Separate notice-specific correlation and state mapping with proven vendor semantics; until then retain events without transitions |
| P1 | Database security | New migration 1361 has not run against private PostgreSQL with the real app role and audit role | BIL-1.5B disposable PostgreSQL RLS/immutability/grant tests |
| P1 | Prior operational items | Platform recovery invocation and durable monitoring/readiness incomplete as reported by BIL-1.5A.1 | BIL-1.5A.3; do not represent as fixed here |
| P2 | Notice location provenance | NOE/NOTR source tables do not provide location ID | Keep null; only populate from validated source association in a separately scoped change |

The code adds no active flag values and no live transmissions. Do not infer payer readiness from local route configuration.
