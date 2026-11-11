# Plan and aggregate balancing

The server-generated plan schema is `claimmd-controlled-posting-plan-v2`. Its digest includes the original source/review revisions and the complete ordered per-claim set: internal claim, attempt/evidence, payer, billed/paid cents, match status, duplicate status, blockers and proposed claim-level payment effect. A change to the set or any bound source revision yields a different plan digest and invalidates approval.

Amounts are parsed into integer cents for equality checks. Every claim must have positive paid amount equal to charge and no patient responsibility or unsupported adjustment facts. The sum of claim payments must exactly equal the 835 payment. No React-supplied amount is authoritative.
