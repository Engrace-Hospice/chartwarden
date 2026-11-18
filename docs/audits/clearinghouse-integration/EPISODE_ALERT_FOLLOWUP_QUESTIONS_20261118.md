# Episode Alert and Medicare follow-up questions

**Prepared:** 2026-11-18

**Status:** draft messages; **not sent**. No vendor reply, account authorization, sandbox access, enrollment or agreement is represented here. Do not include PHI, MBIs, real claims, credentials, or operator identifiers in these messages.

This prioritized follow-up supersedes the 2026-10-25 questionnaire for future use while preserving that file as historical evidence. The older MAC message says “Oregon Part A MAC”; use the jurisdiction-scoped wording below and confirm the actual hospice HH+H contact. Current CMS sources identify Oregon as HH+H J6 and Wellpoint Federal (formerly NGS) effective 2026-04-01, but a provider's payer, enrollment and transaction authorization must still be verified.

## Message 1 — Episode Alert technical and business contact

**Subject:** ChartWarden integration: API access, account isolation, Medicare workflows, and test environment

Hello,

ChartWarden is a hospice EHR evaluating a complementary integration with Episode Alert for Medicare eligibility and, where supported, claim-status, remittance, and DDE workflows. Public product pages describe several of these capabilities, but we need the supported API contract and account-specific requirements before implementation or testing. Please reply in writing and provide the current integration guide, schemas, and approved sample requests/responses.

### A. Partner and account model

1. Is ChartWarden eligible for a software-partner/API integration? What approval, technical review, and partner agreement are required?
2. Which model do you support for multiple hospice customers: a separate customer-owned account, isolated customer subaccounts under a partner account, or a shared platform account? For each supported model, how are tenant, provider entity, and operator identities independently authorized and represented in requests and responses?
3. What stable account/provider identifiers are returned? How are access grants, provider enrollment, revocation, outstanding transactions, and historical response access handled when a tenant disconnects?
4. What pricing and limits apply to API, eligibility, DDE, users, providers, subaccounts, and usage? Does public trial pricing or a trial account include API/partner access?

### B. API access and test isolation

5. Please provide the exact approved API origins, endpoint/method list, authentication and credential lifecycle, scopes/permissions, request and response schemas, error codes, rate limits, timeout/retry guidance, and versioning policy.
6. Is there a vendor-controlled sandbox or other isolated test mode? Please state exactly which account/credential selects it and confirm whether requests can reach a payer, MAC, production data, or live provider record. Are synthetic requests supported without enrollment?
7. Which data and transaction operations are allowed on a trial account? Does “trial” mean an isolated sandbox, or can it access live services? What contractual restrictions govern synthetic and PHI data?

### C. Medicare eligibility, claim status, and remittance APIs

8. For eligibility, provide the exact request/response schema and meaning of every field, including hospice periods, effective dates, revocation, provider identifiers, and unknown/not-found/error responses. Are responses derived from HETS 270/271, and what HETS vendor enrollment relationship is required for each NPI?
9. For claim status, identify whether each result is clearinghouse acknowledgment, payer 276/277 status, FISS/DDE status, or another source. Provide identifiers, status vocabulary, pagination, timestamps, retention, and source attribution.
10. For remittances, provide retrieval methods, format (for example raw 835 or normalized data), pagination/cursors, stable file/transaction identifiers, payee/provider attribution, re-fetch behavior, retention, and supported Medicare HH+H enrollment/routing model.
11. Are results pushed or polled? Document webhook signatures/replay behavior or polling cursors, duplicate delivery, ordering, backfill, and recovery after revoked access.

### D. DDE operations and operator attribution

12. Please answer separately whether a supported API can perform each operation: NOE, NOTR, claim entry, RTP correction, adjustment, cancellation, ADR response, claim status inquiry, and daily change report retrieval. For each supported operation, provide exact request/response documentation and applicable MAC limitations.
13. Are hosted SmartDDE and DDE browser products browser-only, or do they expose documented API operations? Product/browser access alone is not sufficient for our software integration.
14. Can every action be performed under the individually authorized DDE identity of the acting hospice operator? Explain how identities are provisioned, supplied, audited, suspended, revoked, and attributed in each response. A shared vendor or provider identity is not sufficient for ChartWarden's proposed DDE write path.
15. How are uncertain writes reconciled after timeout or lost response? Is there a durable idempotency key, lookup by client correlation ID, and operation-status API? Describe duplicate and replay semantics.

### E. Security, agreements, and support

16. Which entities must execute the BAA and partner/customer agreements for each account model? Please provide the current agreements and identify who is the covered business associate/subcontractor for each data flow. We have seen the public BAA template but have not executed or approved it.
17. State data retention/deletion, request/response logging, encryption, credential rotation, incident notification, audit access, subprocessors, and historical data retrieval after termination.
18. What CMS Network Service Vendor, Medicare HH+H jurisdiction, provider enrollment, HETS, and transaction-specific authorization prerequisites apply? Please distinguish vendor approval from each provider's own enrollment and MAC authorization.

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
| Test isolation and allowed test operations | Any vendor contract execution. A trial credential alone is not a safe-test authorization. |
| Eligibility and HETS details | Hospice-field mapping and production eligibility source selection; each provider NPI's enrollment must be independently confirmed. |
| Claim-status and remittance contracts | #758 status/remittance implementation and qualified response ingestion into M25. |
| Operation-by-operation DDE and per-person identity | #759 write adapter and any provider-submit UI. A “no” on individual attribution keeps writes disabled under ADR-0103 D4. |
| Idempotency, lookup, response attribution | Safe submission/reconciliation and #793 vendor change-feed mapping. In-doubt operations remain manual until reliable reconciliation exists. |
| MAC-specific forms, enrollment, and hospice workflow | Provider activation for the applicable transaction, not generic engineering or local tests. |
| BAA, partner/customer agreements, retention/security terms | PHI exchange and production activation; synthetic, local development may continue. |
| Commercial model | Account onboarding/billing choice; does not block unrelated local engineering. |

Messages are prepared only. No contact, trial, account, credential, enrollment, or vendor request occurred in this lot.
