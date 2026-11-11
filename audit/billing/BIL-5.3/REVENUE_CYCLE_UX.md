# Revenue Cycle UX

The existing `/billing/operations` workspace now includes a compact M25 financial summary with provider and receipt-date filters, retryable read errors, stale-response suppression, formatted monetary values, and explicit source semantics for BPR, CLP, CAS and PLB. It shows A/R as unavailable rather than presenting a derived balance. It links back to existing review surfaces and adds no posting controls.

The M23 A/R dashboard no longer presents expected payer payment as open A/R or claim-created aging. Existing paid-claim operational totals remain labeled as such. The change is deliberately limited to the current workspace rather than a new analytics application.
