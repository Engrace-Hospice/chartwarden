# Integration Dependencies and Boundaries

## BIL-1 Claim.MD foundation

BIL-1.3, 1.4 and 1.5 source commits and migrations are integrated into `origin/develop`. The architecture includes one account-scoped response inbox/cursor, encrypted payload storage, identity resolution against immutable send-time evidence, an acknowledgment dispatcher for approved M23/M41 mappings, account-scoped ERA capture, verified ownership resolution, protected M25 staging, recovery and operational services. This must be reused; do not add a per-tenant Claim.MD account or a second response poller.

The activation backlog remains explicit: two-tenant integrated Response/ERA production-shaped certification, worker multi-process/crash tests, actual authenticated recovery/RLS certification, Claim.MD endpoint/test account certification, notice capability confirmation, legacy cutover, production migration/deployment rehearsal, and final metrics/alert certification are pending in [BIL-1 activation backlog](../BIL-1-ACTIVATION-BACKLOG.md). Default-disabled flags and no automatic posting remain constraints.

The recent sandbox test is narrow evidence only: the sandbox script submitted two synthetic claims and retrieved three matching responses. No ERA endpoint, payer adjudication, commercial route coverage or production Claim.MD workflow was certified. Do not record the result as payer acceptance.

## Shared domain sources

- **M1:** provider entity and location, legal identity, NPI/TIN ownership. Billing claims must preserve provider-entity identity and location snapshots rather than equating tenant, location and provider.
- **M5/M6 and clinical modules:** patient identity/coverage, admission, elections, diagnoses, physician, LOC, certification and addendum facts are consumed through seams. Claim preparation should report missing source data by owner seam and never copy PHI into logs.
- **M23/M41:** share the Claim.MD capture/resolver/dispatcher infrastructure but retain distinct payer rules, claim status machines and independent submission evidence identity.
- **M24:** state-specific adapters and credentials remain distinct from Claim.MD. Do not rewrite M24 transport because BIL-1 uses Claim.MD for M23/M41.
- **M25:** receives remittance advice and handles match/review/posting. Claim workflow may link M25 remittance and denial information, but a claim submission feature must not emit payment effects or create an alternate ERA posting path.

## External dependencies

| Dependency | What must be confirmed | Safe current behavior |
|---|---|---|
| Claim.MD account-wide response/ERA API | Approved test credentials, endpoint authorizations, request limits, retention windows and synthetic account-owned response/ERA fixtures. | Do not activate account capture or ERA workers by this phase. |
| M23 MAC payer route | Claim.MD payer identifier for each applicable MAC/provider route and test-account fixture. | Fail closed if mapping is unresolved; don't send MAC jurisdiction as vendor payer ID by assumption. |
| Commercial payers | Per-plan payer ID, 837I support, clearinghouse enrollment, acknowledgment and correction semantics. | Per-plan readiness gate; no universal “commercial payer enabled” flag. |
| Oregon OHA/CCO | Confirm actual endpoint, authentication, request schema, transport, transaction protocol, acknowledgments, test environment and enrollment for provider entity. | Treat code as modeled reference adapter only; no production route certification. |
| Additional Medicaid states | State companion guides, MCO route, enrollment, transaction format, rates/codes, EVV and test response fixtures. | Deny-stub/unsupported route continues to refuse. |
| Hospice notice capability | Written Claim.MD and MAC/payer support for each NOE/NOTR/transfer transaction and its response semantics. | M23 Claim.MD notice flag remains disabled. |

## Medicare sources checked

- CMS Medicare Claims Processing Manual Pub. 100-04, Ch. 11, Rev. 13190 issued 2025-04-24, specifically §§20.1.1–20.1.3 for NOE/NOTR/transfer and §30.3 for hospice institutional claim data: [official PDF](https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c11.pdf).
- CMS Hospice news page as accessed 2026-11-07 reports mandatory election statement addendum for elections beginning 2026-10-01, temporary enforcement discretion through 2026-12-31, and FY2027 telehealth claim coding effective 2027-01-01: [official page](https://www.cms.gov/medicare/enrollment-renewal/providers-suppliers/information-centers/hospices/news-announcements).

These sources inform the audit; they are not incorporated as a complete payer-specific implementation specification. BIL-2.1 must date-stamp regulatory rule-source reviews.
