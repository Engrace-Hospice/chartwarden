# Medicare Hospice Source and Claim Identity

M23 is the owner of hospice claim submission history. `readM23HistoricalEraCandidates` reads `claim_submission`, the durable clearinghouse attempt, and immutable `claimmd_submission_evidence` under the caller's organization context. It returns the scope, payer/PCN, claim type, submission/attempt identity, state and date evidence required by M25; it does not expose ciphertext, TIN, member identifiers or raw X12.

Historical billed charge is calculated from `claimmd_submission_line_evidence` only when all line rows agree with the parent evidence's organization, provider, claim, submission, attempt, account, environment and payload digest. The current mutable M23 claim total is deliberately not used. Missing or inconsistent line snapshots produce `chargeCents: null` and `submittedLines: unavailable`, preventing amount-based candidate selection.

Attempt lineage is derived from the immutable submitted claim-type frequency component: `7` is replacement, `8` is void, and `1` is original. Unknown values remain `unknown`. Each attempt remains a separate candidate with its own evidence and attempt key.

Medicare context is supported by CMS's [ERA overview](https://www.cms.gov/medicare/coding-billing/electronic-billing/health-care-payment-remittance-advice) and [Medicare Claims Processing Manual, Chapter 11](https://www.cms.gov/regulations-and-guidance/guidance/manuals/downloads/clm104c11.pdf). These references do not authorize WardenX posting policy.
