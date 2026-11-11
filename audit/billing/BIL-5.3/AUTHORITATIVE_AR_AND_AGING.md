# Authoritative A/R and aging

The inspected source does not establish a canonical payer/patient receivable ledger, financial recognition date, or current open balance. M23's legacy aging projection sums mutable expected-payment values and ages from claim creation; it is not a posted-payment-adjusted receivable contract. M25 persists remittance and posting facts but does not itself provide the missing receivable ownership and recognition rules. M26 CAP accrual is not payer A/R.

Accordingly, the Revenue Cycle screen suppresses authoritative A/R and aging. It displays known M25 source facts and explicitly states that no receivable, patient invoice, or write-off is inferred. Implementing A/R requires an approved financial domain contract for charge recognition, payer/patient responsibility, contractual adjustments, application, reversals, and aging basis, plus an authoritative owner and ledger.
