# BIL-4.2 — Partial Payments & Outstanding Balance Integrity

## Result

The controlled M25 Claim.MD plan now accepts a narrow partial-payment case: one positive M41 commercial claim with exactly one claim-level OA CAS adjustment that equals charge minus paid, zero CLP/CAS patient responsibility, no service-line adjudication, no remarks or references, and an M25 adjustment classification that routes to `flagged_review`. Any other partial facts remain blocked. No patient invoice, contractual write-off, or payer receivable is created for the residual.

M25 remains the owner of adjustment persistence and emits `m25.remittance.claim_partial_paid`; M41 transitions to `partially_paid`, and M26 records only the actual payer-paid amount. The existing immutable approval and transaction-bound posting path is reused. Production and automatic posting remain disabled.

## Verification

See [POSTGRESQL_FINANCIAL_TESTS.md](POSTGRESQL_FINANCIAL_TESTS.md), [NON_REGRESSION.md](NON_REGRESSION.md), and [REMAINING_BLOCKERS.md](REMAINING_BLOCKERS.md). The verdict is limited to the exact scenario above; it does not authorize general CAS, patient-responsibility, line-level, PLB, reversal, or recoupment posting.
