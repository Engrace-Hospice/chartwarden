# Financial source-of-truth matrix

| Fact | Owner/source | Read contract | Limitation |
|---|---|---|---|
| Current commercial claim identity, plan, provider, state, current charge, caseload | M41 commercial claim read service | `getClaim` | Charge is mutable current data, not an immutable transmitted amount |
| Original submitted charge | No generic M41 historical line snapshot surfaced by this path | Not available | Returned as `null`; never inferred from current claim charge |
| ERA-reported claim payment | M25 parsed remittance line CLP04 | M25 `commercialClaimPaymentFacts` | Source-reported amount is not proof of bank settlement |
| Posted claim payment | M25 line with `match_state='posted'`, positive CLP04, non-void CLP status, and advice in posted/partial-posted state | Same M25 read | Amount is the persisted claim line effect, not the full advice envelope |
| Adjustments and PLB | M25 CAS / PLB records | Existing M25 report | Claim adjustments and provider-level PLB remain distinct; no inferred allocation |
| A/R and aging | No canonical payer/patient receivable ledger | Explicit `unavailable` contract | No billed-minus-paid calculation |
