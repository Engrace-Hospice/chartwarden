# Episode Alert and Medicare follow-up questions

**Prepared:** 2026-11-18

**Status:** draft messages; **not sent**. No vendor reply, account authorization, sandbox access, enrollment or agreement is represented here. Do not include PHI, MBIs, real claims, credentials, or operator identifiers in these messages.

This prioritized follow-up supersedes the 2026-10-25 questionnaire for future use while preserving that file as historical evidence. The older MAC message says “Oregon Part A MAC”; use the jurisdiction-scoped wording below and confirm the actual hospice HH+H contact. Current CMS sources identify Oregon as HH+H J6 and Wellpoint Federal (formerly NGS) effective 2026-04-01, but a provider's payer, enrollment and transaction authorization must still be verified.

### Priority for the vendor response

The maintainer's product priority is NOE/NOTR workflows. Ask first whether those notices can be submitted programmatically, through which supported route, what receipt/MAC outcome evidence is returned, and how corrections and uncertain outcomes are reconciled. This is `MAINTAINER_REPORTED`, not a vendor answer. The eligibility, general claim-status, remittance, and ordinary claim-submission questions remain below as secondary integration questions; they are not cancelled.

## Message 1 — Episode Alert technical and business contact

**Subject:** ChartWarden integration: API access, account isolation, Medicare workflows, and test environment

Hello,

ChartWarden is a hospice EHR evaluating Episode Alert primarily for Medicare hospice NOE/NOTR submission, tracking, correction, and reconciliation. Eligibility, general claim status, remittances, and ordinary claim submission remain secondary questions. Public product pages describe several capabilities, but we need the supported API contract and account-specific requirements before implementation or testing. Please reply in writing and provide the current integration guide, schemas, and approved sample requests/responses.

### A. Partner and account model

1. Is ChartWarden eligible for a software-partner/API integration? What approval, technical review, and partner agreement are required?
2. Which model do you support for multiple hospice customers: a separate customer-owned account, isolated customer subaccounts under a partner account, or a shared platform account? For each supported model, how are tenant, provider entity, and operator identities independently authorized and represented in requests and responses?
3. What stable account/provider identifiers are returned? How are access grants, provider enrollment, revocation, outstanding transactions, and historical response access handled when a tenant disconnects?
4. What pricing and limits apply to API, eligibility, DDE, users, providers, subaccounts, and usage? Does public trial pricing or a trial account include API/partner access?

### B. API access and test isolation

5. Please provide the exact approved API origins, endpoint/method list, authentication and credential lifecycle, scopes/permissions, request and response schemas, error codes, rate limits, timeout/retry guidance, and versioning policy.
6. Is there a vendor-controlled sandbox or other isolated test mode? Please state exactly which account/credential selects it and confirm whether requests can reach a payer, MAC, production data, or live provider record. Are synthetic requests supported without enrollment?
7. Which data and transaction operations are allowed on a trial account? Does “trial” mean an isolated sandbox, or can it access live services? What contractual restrictions govern synthetic and PHI data?

### C. Primary hospice NOE/NOTR submission and reconciliation

8. Do you support programmatic Medicare hospice NOE and NOTR submission for a hospice provider? For each notice, identify the supported route: institutional EDI, a documented DDE API operation, or another documented route. Please provide the exact guide and distinguish API submission from hosted/browser DDE.
9. Which hospice notice types/formats and provider/MAC combinations are supported? Provide the required transaction/TOB variants, fields, validation rules, and any limits. Please identify whether support differs between the EDI and DDE paths.
10. What immediate submission receipt and later MAC acceptance/rejection/return evidence is available? Include stable identifiers, acceptance-date source, status vocabulary, polling/report/webhook behavior, retention, and how to correlate each result to one notice attempt.
11. How are correction, cancellation, and resubmission handled for each notice? What happens after timeout/lost response or an ambiguous submission? Is there idempotency or lookup by client correlation identifier? Please distinguish known refusal-before-send from an uncertain outcome.
12. If the DDE route is used, can the operation be performed under each individually authorized hospice operator's own identity? How are operator identity and authorization provisioned, revoked, and reflected in receipts/outcomes?

### D. Secondary APIs: eligibility, claim status, and remittance

13. For eligibility, provide the exact request/response schema and meaning of every field, including hospice periods, effective dates, revocation, provider identifiers, and unknown/not-found/error responses. Are responses derived from HETS 270/271, and what HETS vendor enrollment relationship is required for each NPI?
14. For general claim status, identify whether each result is clearinghouse acknowledgment, payer 276/277 status, FISS/DDE status, or another source. Provide identifiers, status vocabulary, pagination, timestamps, retention, and source attribution.
15. For remittances, provide retrieval methods, format (for example raw 835 or normalized data), pagination/cursors, stable file/transaction identifiers, payee/provider attribution, re-fetch behavior, retention, and supported Medicare HH+H enrollment/routing model.
16. Are results pushed or polled? Document webhook signatures/replay behavior or polling cursors, duplicate delivery, ordering, backfill, and recovery after revoked access.

### E. Other programmatic DDE operations

17. Separate from NOE/NOTR, does a supported API perform claim entry, RTP correction, adjustment, cancellation, or ADR response? Please answer each independently and provide applicable MAC limits and formats. These are secondary capabilities; absence of a route must not be inferred from product-page wording.
18. Are hosted SmartDDE and DDE browser products browser-only, or do they expose documented API operations? Product/browser access alone is not sufficient for software integration.

### F. Security, agreements, and support

19. Which entities must execute the BAA and partner/customer agreements for each account model? Please provide the current agreements and identify who is the covered business associate/subcontractor for each data flow. We have seen the public BAA template but have not executed or approved it.
20. State data retention/deletion, request/response logging, encryption, credential rotation, incident notification, audit access, subprocessors, and historical data retrieval after termination.
21. What CMS Network Service Vendor, Medicare HH+H jurisdiction, provider enrollment, HETS, and transaction-specific authorization prerequisites apply? Please distinguish vendor approval from each provider's own enrollment and MAC authorization.

We will not send real beneficiary data until contractual, security, and authorization review is complete. We have not assumed a trial account is a sandbox. Thank you.

## Message 2 — Hospice provider enrollment owner to the applicable HH+H MAC

**Subject:** Hospice provider enrollment and authorization for an NSV/API and DDE workflow

Hello,

We are preparing an integration review for a hospice provider in Oregon. CMS materials reviewed on 2026-11-18 place Oregon in Home Health & Hospice jurisdiction J6 and identify Wellpoint Federal (formerly NGS) for HH+H J6 effective 2026-04-01. Please confirm that this is the correct current HH+H enrollment contact and route for the specific provider; we are not assuming that an older Oregon Part A payer identifier is the hospice HH+H destination.

Please answer for the provider's actual enrollment and the proposed Network Service Vendor, Episode Alert:

1. Which current forms, agreements, trading-partner/vendor authorizations, and provider attestations are required for this hospice to use Episode Alert for HETS eligibility, institutional claims/notices, claim status, remittance delivery, and/or FISS/DDE? Please distinguish requirements by transaction.
2. For HETS 270/271, what exact provider action and enrollment relationship is required for each NPI submitted through Episode Alert? CMS's May 11, 2026 validation requires a current relationship between each submitted NPI and the third-party HETS submitter; please confirm the applicable process and status lookup for this provider.
3. What identifiers and records are required for HH+H transaction enrollment (billing NPI, TIN, PTAN and/or CCN, and any other provider identifiers)? Please explain which are distinct and which are required for each transaction. Do not assume CCN and PTAN are interchangeable.
4. For DDE, are identities issued to and attributable to individual people? May an authorized vendor-hosted session use each operator's own identity? What access classes and authorization steps apply to NOE, NOTR, claim entry, RTP correction, adjustment, cancellation, ADR response, and read/status reporting?
5. What is the approved process for provisioning, reviewing, suspending, and promptly revoking an individual operator's DDE access? What records must the hospice retain?
6. Does the MAC accept provider-submitted NOE/NOTR and other hospice operations through this vendor or API? Please identify hospice-specific transaction, format, timing, correction, and cancellation requirements and any operation that must remain in direct DDE/FISS.
7. How can the provider verify current payer/MAC enrollment and effective dates, including ERA routing? What transition steps are required if vendor access or the hospice's clearinghouse changes?
8. Please identify current official guidance and the appropriate enrollment/EDI/DDE contact for follow-up. We will not include patient data in this inquiry.

Thank you.

## Blocker map

| Answer set | Specifically blocks |
|---|---|
| Vendor partner access, account model, approved origin/auth/schema | #758 eligibility contract implementation and consumer; account-scoped configuration; all vendor-facing calls. |
| NOE/NOTR route, format, receipt, MAC outcome and recovery | #759 primary write direction, single-route notice policy, filing-status reconciliation and any provider-assisted UI. |
| Test isolation and allowed test operations | Any vendor contract execution. A trial credential alone is not a safe-test authorization. |
| Eligibility and HETS details | Hospice-field mapping and production eligibility source selection; each provider NPI's enrollment must be independently confirmed. |
| Claim-status and remittance contracts | #758 status/remittance implementation and qualified response ingestion into M25. |
| Operation-by-operation DDE and per-person identity | #759 DDE route and any provider-submit UI. A “no” on individual attribution keeps DDE writes disabled under ADR-0103 D4; it does not prove an EDI notice route exists. |
| Idempotency, lookup, response attribution | Safe submission/reconciliation and #793 vendor change-feed mapping. In-doubt operations remain manual until reliable reconciliation exists. |
| MAC-specific forms, enrollment, and hospice workflow | Provider activation for the applicable transaction, not generic engineering or local tests. |
| BAA, partner/customer agreements, retention/security terms | PHI exchange and production activation; synthetic, local development may continue. |
| Commercial model | Account onboarding/billing choice; does not block unrelated local engineering. |

Messages are prepared only. No contact, trial, account, credential, enrollment, or vendor request occurred in this lot.
