# Stedi: written questions to send (issue #727)

**Updated:** 2026-11-16 · **Status:** ready to send; **not sent**. The public-documentation notes below are not
vendor-specific written answers for ChartWarden. Track replies in
[`STEDI_QUESTIONS_20261008.md`](./STEDI_QUESTIONS_20261008.md), then attach a separately completed
[`STEDI_SANDBOX_RESULTS_TEMPLATE_20261025.md`](./STEDI_SANDBOX_RESULTS_TEMPLATE_20261025.md) after an authorized run of
[`STEDI_SANDBOX_RUNBOOK_20261025.md`](./STEDI_SANDBOX_RUNBOOK_20261025.md).

## Message to Stedi

**Subject: Written confirmation requested: hospice 837I testing, tenant accounts, Medicare enrollment and BAA**

Hello Stedi team,

ChartWarden is a multi-tenant hospice EHR and billing platform. Each hospice organization using ChartWarden selects its own
clearinghouse provider (`Stedi`, `Claim.MD`, or a biller outside ChartWarden) and maintains its own provider configuration,
credential, enrollment evidence, and vendor BAA. This is our architecture decision; we are asking which Stedi account and
integration arrangements can support it. We are not assuming that a reseller, OAuth, or Integrated Account relationship
has been approved for ChartWarden.

Please answer each item in writing, identify any account or transaction limitations, and link the applicable current
documentation, payer/MAC companion guide, or enrollment instructions. If an answer depends on our Stedi account type or
commercial approval, please say so and identify the approval/contact process. Our questions concern synthetic test data
and workflow design only; this message contains no credentials, PHI, or real payer transaction.

### A. Test claims and responses — Q14

1. We understand from your [test-claims workflow](https://www.stedi.com/docs/healthcare/test-claims-workflow) and
   [test-mode guide](https://www.stedi.com/docs/healthcare/test-mode) that a free Sandbox account cannot submit test
   claims; test claims use a **Test-mode API key belonging to a Production account**, and those test transactions are not
   sent to payers. Please confirm this applies to the 837I API route and to the account that ChartWarden would use.
2. Please confirm the 837I JSON behavior when `usageIndicator` is `T`, and raw X12 behavior when `ISA15` is `T`. What
   response should we expect if key mode and transaction usage disagree? Please confirm that a Production-mode key can
   never route a test-marked 837I to a payer.
3. Please confirm that test claims sent to an arbitrary payer ID return only Stedi's test 277CA and never reach that
   payer. Which response stages are represented by that 277CA, and which additional responses can follow in test mode?
4. To receive a test 835, your documentation says to enroll a provider with the Stedi Test Payer for 835 Claim payment,
   create that enrollment in Production mode, then submit with Test credentials. Please confirm the required synthetic
   provider fields, whether this test enrollment is isolated from real payer routing, and whether any account approval,
   agreement, or other prerequisite applies.
5. The existing ChartWarden contract test uses synthetic raw 837I, a Test-mode API key, `ISA15=T`, and refuses a
   Production-marked interchange locally. It records only transport submission outcomes; it does not retrieve or assert a
   277CA/835. Is this an appropriate safe test of the current adapter contract? Please identify any additional test-mode
   constraints.

### B. Tenant account model, Integrated Accounts and OAuth — Q32 (Q27 response attribution)

Your [Integrated Account overview](https://www.stedi.com/docs/healthcare/integrated-account-overview) describes an account
per provider or practice linked to a product through a Stedi app. Your [OAuth-app guide](https://www.stedi.com/docs/healthcare/oauth-apps)
currently labels access as private preview and says to contact Stedi. Please confirm:

1. Can each ChartWarden tenant use its own Stedi Production account and credential, with ChartWarden acting only within
   the account that tenant authorizes? Is this supported for hospice organizations, and what partner approval is required
   before ChartWarden can register or publish an OAuth app?
2. Are Integrated Accounts available to ChartWarden now? What onboarding, review, contractual, security, or listing
   approval is required? Is OAuth mandatory for a new platform integration, and are legacy API-key apps unavailable to
   new partners?
3. Can one integrated account represent an organization with multiple provider entities, NPIs, tax IDs, and MAC
   enrollments? If so, how are provider records and enrollment permissions scoped within that account?
4. How does Stedi isolate claims, 277CA acknowledgments, 835 ERAs, events, and polling results by integrated account?
   Which stable account/provider identifiers are present in callbacks, event payloads, report results, and polling results
   so our tenant binding can verify the destination before processing?
5. Does the tenant retain control of its Stedi credentials, provider records, and payer enrollments? Can ChartWarden
   create or manage enrollments only with the tenant's authorization, and what audit trail is available to the tenant?
6. Can Stedi offer consolidated/reseller billing across separately owned tenant accounts? If available, what contract and
   account relationship does that require?
7. What happens to outstanding submissions, acknowledgments, and ERAs when a tenant uninstalls the app, revokes access,
   closes its Stedi account, or changes clearinghouses? How are credentials revoked and data retained/deleted?
8. Are Test-mode and Production-mode credentials issued separately for each integrated account? Can test claims and test
   response retrieval be used with an integrated account? We understand the OAuth app itself cannot use Test mode; please
   confirm the supported way to validate an integration without submitting a Production transaction.

### C. Medicare Part A, hospice and enrollment — Q16

1. For Original Medicare Part A hospice institutional claims (837I, including hospice TOB 81x/82x), NOE/NOTR and ERA
   835, which MAC jurisdictions and Stedi payer IDs are supported? Please answer separately for claims, notices, and
   ERA; do not assume support for one transaction type establishes support for the others.
2. For Oregon hospice, please confirm whether `MDCKC` / payer ID `12M41` is the correct route, whether the applicable
   enrollment requires a PTAN, and whether NGS `MFPWU` / `13001` is unsupported for this workflow.
3. What enrollment is required for 837I claim submission and 835 ERA, and is it separate for NOE/NOTR? Is enrollment
   scoped by NPI, tax ID, CCN/PTAN, provider organization, MAC jurisdiction, Stedi account, or transaction type? How are
   multiple provider entities and NPIs represented under one ChartWarden tenant?
4. What provider documents and authorized signatures are required, who submits the enrollment, and what are the current
   typical and worst-case approval timelines? Which steps are performed by Stedi versus the hospice/provider or MAC?
5. When moving an NPI's ERA from another clearinghouse, how do we avoid an interruption or competing 835 destinations?
   Can an effective date be coordinated, and what happens to remittances still pending at the prior clearinghouse?
6. Can synthetic 837I/NOE/NOTR testing proceed before Medicare enrollment is approved, and which results are only
   Stedi-test evidence rather than MAC acceptance or enrollment evidence?

### D. Rejected claims, replacements, voids and FISS/DDE — Q17 and Q28

Your [resubmission guide](https://www.stedi.com/docs/healthcare/resubmit-cancel-claims) says Medicare institutional
resubmissions use the original Claim Frequency Code and omit the payer claim control number; generic institutional claim
documentation also describes frequency codes 7 and 8. Please clarify the workflow and its limits without treating
rejection correction and post-adjudication adjustment as the same case:

1. If Stedi or the MAC rejects an 837I before adjudication, should the provider correct the data and resubmit with the
   original frequency code? What identifiers should be included or omitted?
2. For an already adjudicated/paid Original Medicare hospice claim, what is the supported path for a correction/replacement
   and for a cancellation/void? Are TOB 8x7/8x8 with frequency 7/8 supported through Stedi for any Medicare MAC, or must
   the provider use a different MAC workflow?
3. Please explain where FISS/DDE is required or preferred, and how the provider should reconcile a correction submitted
   through FISS/DDE with the original electronic claim and subsequent ERA.
4. Does Stedi's edit accepting a synthetic 837I with frequency 7/8 and `REF*F8` establish only X12/edit acceptance, or
   does it establish routing and MAC acceptance? Please provide the applicable hospice/MAC guidance. We will not infer
   universal support or prohibition from a generic article or an edit result.

### E. BAA, responsibilities and lifecycle — Q33

1. For the tenant-owned Stedi account model, does Stedi execute a BAA directly with each hospice organization? Does
   ChartWarden also need a separate BAA as an integration/app provider, and is a separate agreement needed for OAuth
   app access or support sessions?
2. Which entity is the account/contract owner for an Integrated Account? Who is responsible for provider identity,
   transaction and ERA enrollments, credential issuance/revocation, and keeping enrollment evidence current?
3. Please provide the applicable BAA, service terms, subprocessor list, security documentation, incident-notification
   process, audit evidence, and PHI retention/deletion terms for both the Stedi account and the integrated app.
4. What is the process and timeline to revoke a tenant's app authorization, API credentials, provider enrollments, and
   support access? How are queued transactions and pending responses handled after revocation or a clearinghouse switch?
5. Please identify any differences in BAA or PHI obligations between synthetic Test-mode traffic and Production traffic.

### F. Response requested

Please reply inline, mark any unsupported or account-dependent case explicitly, and include links to the current technical
documentation, payer/MAC companion guides, enrollment forms, and contractual documents. We will record your response in
the linked audit matrix. Legal/compliance review and engineering readiness are separate approvals on our side.

Thank you,

ChartWarden Integration Team

---

## Internal state while waiting

| Topic | WardenX position | Remains open until |
|---|---|---|
| Tenant account selection | Already decided in ADR-0053: each tenant chooses `stedi`, `claimmd`, or `outside` and owns its configuration, credential, and vendor BAA. | Vendor confirms an account/integration model that can support a tenant-owned Stedi connection. |
| OAuth / Integrated Accounts | Potential fit documented publicly; availability is shown as private preview. No ChartWarden approval is assumed. | Stedi confirms partner availability, approvals, account scoping, and test-safe validation route. |
| Test claims | Public docs describe Production account + Test-mode API key; Sandbox accounts cannot submit test claims. Test claims are not routed to payers. | Stedi confirms applicability to ChartWarden/837I and any account provisioning needed. |
| Test ERA | Public docs require a provider enrollment with the Stedi Test Payer created outside Test mode; test credentials are then used for test submissions. | Vendor clarifies the synthetic provider/enrollment procedure and an authorized run records the response. |
| Medicare hospice | No generic Stedi docs establish all MAC hospice claim/notice/ERA workflows. | Stedi/MAC provide payer-specific enrollment and workflow evidence. |
| Frequency 7/8 | Generic Stedi guidance says Medicare institutional resubmissions use the original CFC; no global hospice rule inferred. | Stedi/MAC clarify rejected versus paid-claim correction/void and FISS/DDE path. |
| BAA | Public BAA exists; this does not establish the correct signer or ChartWarden's app-provider obligations. | Legal/compliance reviews applicable documents and Stedi answers account-relationship questions. |

Nothing in this repository sends this message, opens an account, obtains a key, or enables production transmission.
