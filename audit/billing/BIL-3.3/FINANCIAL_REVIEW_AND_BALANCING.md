# Financial review and balancing

`projectEraFinancialReview` in `apps/backend/src/modules/25-remittance/domain/era-financial-review.ts` projects only parsed 835 source values. It reports claim charge/payment, patient responsibility, claim CAS totals, service-line CAS totals and provider-level PLB totals independently. It never derives an allowed amount or allocates adjustment values.

Amounts are converted from parser decimal values to integer cents; invalid precision or unsafe integers produce unavailable amounts. Existing `checkEraPaymentBalance` is reused: sum of claim payments minus parser-sign PLB adjustments is compared with BPR reported payment. A discrepancy or unavailable source is explicit.

CLP status 4 is shown as payer-denied, status 22 as reversal, zero payment remains a separate status, and incomplete monetary facts remain insufficient data. CAS groups are category labels only, not accounting instructions. Unknown groups and reason descriptions remain unsupported/description unavailable. See [CMS group-code definitions](https://bluebutton.cms.gov/fhir/CodeSystem/ANSI-GRP-CD/) and [CMS ERA guidance](https://www.cms.gov/medicare/coding-billing/electronic-billing/health-care-payment-remittance-advice).

Review completion is blocked by held stage, duplicate classification, hard identity conflict, or a supported balance discrepancy. Unresolved identity and missing line evidence remain visible follow-up/posting blockers. Review completion does not indicate bank settlement or authorize posting.
