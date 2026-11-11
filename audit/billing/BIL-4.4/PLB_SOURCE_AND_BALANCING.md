# PLB Source and Balancing

`packages/x12-835-client/src/parse-x12-835.ts` now preserves PLB provider identifier, normalized fiscal date, reason, reference, exact signed amount, segment position and pair occurrence. The parser retains each adjustment separately. Claim.MD stage details persist the parsed transaction set in existing encrypted stage storage; no schema migration was required.

`apps/backend/src/modules/25-remittance/domain/era-match-review.ts::checkEraPaymentBalance` uses integer cents and the 835 convention `reported payment = sum(claim payments) - sum(PLB amounts)`. Positive PLB reduces net reported payment; negative PLB increases it. Read-only financial review exposes claim-payment total, signed PLB total, reported payment and balance outcome. It does not distribute PLB to claims or infer bank cash.

Reason classification recognizes `WO` as overpayment-recovery-reported and `FB` as forward-balance-reported. Other codes remain generic. References are reported source evidence, not verified historical links. Provider identifiers are masked in tenant-facing detail.

External semantics consulted: [CMS ERA overview](https://www.cms.gov/medicare/coding-billing/electronic-billing/health-care-payment-remittance-advice), [X12 005010X221](https://ecommerce.x12.org/assets/tr3/x221-005010-PDF.pdf), [X12 RFI 2231](https://x12.org/resources/requests-for-interpretation/rfi-2231-refund-with-payer-letter) and [X12 RFI 1756](https://x12.org/resources/requests-for-interpretation/rfi-1756-balance-forward-processing). These references do not establish a WardenX accounting policy.
