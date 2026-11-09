# Matching and Financial Gaps

## What exists

- BIL-1 ownership resolution checks the 835 payee against verified provider identity and correlates claim PCNs to immutable M23/M41 submission evidence within account/environment and tenant/provider scope.
- Outcomes include verified, ambiguous, conflict and unmatched. Ambiguous/conflicting ownership does not become a tenant stage eligible for review.
- Existing M25 `postAdvice` candidate matching can resolve claims using payer, PCN and payer ICN evidence; its provider may safely return no candidates, leaving lines unmatched for manual handling.
- Existing manual match is a mutation of a posted/ingested `remittance_line`; it is not a matcher for Claim.MD stage rows.
- Legacy posting has exact-identity duplicate holds, line/claim adjustment classification, denial and patient-responsibility ledger paths, and reversal/recoupment handling.

## Not yet implemented

1. Service-line-level association from a Claim.MD staged 835 to tenant claim lines with persisted match evidence.
2. Manual resolution of staged unmatched/ambiguous claim or service-line outcomes.
3. A durable tenant-visible event timeline for stage preparation, ownership resolution, duplicate decision, delivery receipt and authorized review.
4. Full PLB classification/allocation and bank deposit/EFT reassociation.
5. A review approval model distinct from posting authorization.
6. Controlled posting for the new Claim.MD stage source.
7. PostgreSQL integrated verification of cross-source financial idempotency, concurrent consumers and tenant RLS for this phase.

The review screen therefore presents the current ownership/identity result, claim and service-line details, adjustments, provider adjustments, duplicate/hold information, and whether the staged item is eligible for future reconciliation. It does not claim that an identity match is a financial allocation or that `staged` means paid/reconciled.

## Money precision

The new UI formats each source amount for display and does not sum or balance values. Existing M25 persistence uses database decimal strings/columns and existing integer-cent event fields where defined. No BIL-3.0 financial calculation or ledger write was added.
