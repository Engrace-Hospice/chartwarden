# Payment status and partial posting

The M25 summary now exposes `postedClaimPaymentCents`: only positive CLP04 rows whose line is persisted as `posted`, advice status is `posted` or `partial_posted`, and CLP02 is not void/reversal status 22. Thus a partially posted advice can contribute its actually posted matched lines, while unmatched lines are excluded. `fullyPostedClaimPaymentCents` remains the narrower fully-posted-advice measure for compatibility. BPR envelope totals, CLP-reported totals, CAS group totals and provider-level PLB remain separate.

For claim detail, each matched M25 line returns payer-reported amount, actual posted amount (or null when not posted), advice status and receipt time. OA or other adjustments are not converted into receivables, patient bills or write-offs. M41's current claim state is separate from M25 remittance state. Neither ERA posting nor M25 posting proves bank settlement.
