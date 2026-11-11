# CAS, CLP, and patient responsibility

The BIL-4.2 assessment does not add CLP05 to CAS totals. It requires CLP patient responsibility to be zero and blocks PR CAS in this narrow scenario. Thus patient responsibility cannot be double-counted or treated as an invoice authorization.

Only a single claim-level OA CAS amount may be accepted, and it must equal charge less paid. Existing M25 routing is checked to yield `flagged_review`, with neither patient-responsibility ledger seeding nor denial seeding. CO, PR, PI, multiple CAS entries, service-level CAS, unknown/unmapped CARC, PLB, and unsupported signed effects remain ineligible.

CMS explains that ERA reports payment and adjustment information and that group codes identify responsibility categories: [CMS Health Care Payment and Remittance Advice](https://www.cms.gov/medicare/coding-billing/electronic-billing/health-care-payment-remittance-advice). This implementation does not infer posting authority from the code category alone.

The X12 RFI on claim balancing states the CLP charge less claim/line CAS adjustments must equal CLP paid: [X12 RFI #2601](https://x12.org/resources/requests-for-interpretation/rfi-2601-claim-line-balancing-relationship-charged-allowed). The new parser regression uses a synthetic balanced CLP/CAS example; production eligibility remains narrower than parsing.
