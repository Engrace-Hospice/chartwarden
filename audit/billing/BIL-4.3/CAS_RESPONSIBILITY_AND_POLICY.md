# CAS responsibility and policy

The plan assessment in `apps/backend/src/modules/25-remittance/ingest/service-drizzle.ts::assessClaimMdFinancialFacts` now distinguishes reported responsibility from an authorized accounting effect. It retains each claim CAS group, CARC and amount in cents; source signs are preserved by conversion, while unsupported negative amounts fail eligibility.

The projection labels CO as provider-reported, PR as patient-reported, OA as unallocated/review, PI as payer-initiated, and CR as correction/reversal. These are payer source classifications, not WardenX authorization. CMS describes group codes as responsibility indicators; X12 claim balancing references describe source arithmetic. Neither establishes an organization-specific accounting policy. [CMS ERA/SPR guidance](https://www.cms.gov/medicare/coding-billing/electronic-billing/health-care-payment-remittance-advice), [CMS group-code dictionary](https://bluebutton.cms.gov/fhir/CodeSystem/ANSI-GRP-CD/), [X12 RFI #2601](https://x12.org/resources/requests-for-interpretation/rfi-2601-claim-line-balancing-relationship-charged-allowed).

The codebase has CARC taxonomy and a tenant denial-taxonomy overlay, but no effective-dated organization/provider/payer contractual-adjustment accounting policy contract. Taxonomy is not write-off authorization.
