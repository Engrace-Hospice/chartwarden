# Medicare Financial Review and Posting Blockers

M25 reuses its existing CAS/PLB parsing, balancing and nonposting financial-review projections. The staged ERA's source facts and any adjustments remain visible in the current Revenue Cycle review. Provider-level adjustments remain separate from claim amounts and existing policy guards remain in force.

`derivePostingFacts` identifies an M23 owner candidate and adds `MEDICARE_POSTING_NOT_CERTIFIED` to that claim's blockers. The immutable plan records `billingModule: M23`; the UI links to the M23 claim. Approval re-derives the plan and rejects the blocked plan with `POSTING_PLAN_STALE_OR_BLOCKED`. This is enforced server-side and does not depend on button state.

No Medicare payment, adjustment, advice, M25 ledger record or claim-paid/advice-posted event is created by review. Medicare posting, MAC route certification, and any Medicare-specific financial semantics remain outside this phase.
