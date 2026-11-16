# Questions for Stedi: hospice DDE/clearinghouse integration

> **Current dossier update (2026-11-16):** The send-ready version is
> [`STEDI_QUESTIONS_TO_SEND_20261025.md`](./STEDI_QUESTIONS_TO_SEND_20261025.md). It supersedes the original Q32 wording
> below, which assumed a shared platform account was still an undecided default. ADR-0053's 2026-11-06 amendment makes
> clearinghouse selection a per-tenant decision. Current official Stedi documentation and the status of every Q1-Q33 are
> recorded in [the 2026-11-16 evidence matrix below](#evidence-and-answer-matrix-2026-11-16). Existing vendor replies and
> dated observations below are preserved as historical evidence.

**Date:** 2026-10-08
**Context:** ChartWarden is a multi-tenant hospice EHR. We want to submit Medicare hospice institutional
claims, Notices of Election (NOE, TOB 8xA) and Notices of Termination/Revocation (NOTR, TOB 8xB)
through Stedi, receive 277CA and 835 responses, and run Medicare eligibility checks.

Please answer in writing. Items marked **blocking** gate our build.

## Payer and transaction support

1. **(blocking)** Does the National Government Services payer record (Stedi ID `MFPWU`, payer ID 13001)
   cover hospice institutional claims (TOB 81x/82x) for the HH+H jurisdictions? Which MAC jurisdictions
   and payer IDs should we use for J6 and for other MACs?
2. **(blocking)** Are NOE (8xA) and NOTR (8xB) accepted through the 837I raw X12 endpoint? Does the 837I
   JSON endpoint accept `A`/`B`/`C`/`D`/`E` in `claimFrequencyCode` (the documented list is 1, 2, 3, 4, 7, 8, 9)?
3. **(blocking)** How are adjustments (TOB 8x7) and cancels (8x8) of already-adjudicated Medicare claims
   submitted? Your resubmission guidance says Original Medicare does not accept frequency codes 7 or 8
   and that the payer claim control number must be omitted. Does that apply only to rejected-claim
   resubmissions, or also to adjustments/cancels of paid claims?
4. Are transfer notices (8xC/8xD) supported?

## Enrollment

5. **(blocking)** What is the enrollment unit for Medicare institutional claims and 835: per NPI, per
   provider entity, or per tenant? Is a PTAN required? Typical lead time?
6. Is a separate enrollment needed for NOE/NOTR vs claims?

## Authentication and tenancy

7. **(blocking)** Your integrated-account docs say new apps must use OAuth. Please confirm the current
   recommended model for a multi-tenant SaaS: one integrated account per tenant, per provider entity, or
   a shared platform account? How do test and production API keys relate to integrated accounts?

## Responses and events

8. For API submissions, after Stedi's initial 277CA, how long until the MAC's 277CA typically arrives?
   Are any 999s delivered for API submissions?
9. What event types do event destinations emit for 277CA and 835 delivery? Are payloads references only?
   How are events signed, and how should we verify them? What are the retry/ordering guarantees?
10. Recommended polling window and endpoint for reconciliation of missed events.

## Eligibility

11. What is the recommended path for Medicare (HETS) eligibility, and can it accept our existing X12
    270 over a CORE-style endpoint with a bearer token? Requirements for `X-Forwarded-For` and for
    production test data.

## Testing and certification

12. What does test mode cover for hospice claims and NOE/NOTR? What certification or pilot steps do you
    and the MAC expect before production?
13. Idempotency keys last 24 hours. Any recommended pattern for longer-term duplicate protection?

## Answers received 2026-10-09 (Customer Operations, by email)

- **Raw X12 837I:** Stedi generates the envelopes. Set `ST03` to `005010X223A2` and put the payer ID in 2010BB `NM109`. (Q1/Q2 in part)
- **Responses:** 999s, Stedi's 277CA, the MAC's 277CA and 835s all arrive as processed transaction events. Payloads are references (`transactionId`, `fileExecutionId`). Each destination has its own rotatable signing secret. Use the poll transactions endpoint to reconcile missed events. (Q9, Q10)
- **Eligibility:** Medicare runs through HETS (payer ID `CMS`) via raw X12 or the CAQH CORE SOAP endpoint. Each NPI needs CMS enrollment and attestation, which Stedi handles. Pass upstream IPs in `X-Forwarded-For`. Requests from outside the U.S. are blocked, and production testing with CMS is coordinated through Stedi. (Q11)
- **Testing:** test claims to any payer ID return test 277CAs, and the Stedi Test Payer returns test 835s. (Q12 in part)
- **Not yet answered:** hospice-specific items and tenant setup, to be covered on a 30-minute technical call. Stedi also asked for expected weekly or monthly volume of checks and claims.

Note: the answer that test claims to any payer ID return test 277CAs does not match what the sandbox
returned on 2026-10-09 (`ACCOUNT_NOT_PROVISIONED` on every 837I that passed edits). See follow-up Q14.

## Follow-up questions (sandbox probe, 2026-10-09)

Payer search with the sandbox key shows Medicare Oregon Part A as Stedi ID `MDCKC`, payer ID `12M41`,
with 837I, 835 and eligibility all `ENROLLMENT_REQUIRED`. NGS `MFPWU` (13001) shows 837I
`NOT_SUPPORTED`.

14. Our sandbox key returns `ACCOUNT_NOT_PROVISIONED` (HTTP 400) on every 837I that passes your edits,
    and on 277/835 report fetches and the polling endpoint. Your reply says test claims to any payer ID
    return test 277CAs. What provisioning does this account need, and can you enable it?
    **Note (2026-10-25, Stedi docs, [test claims workflow](https://www.stedi.com/docs/healthcare/test-claims-workflow)):**
    the page says "Sandbox accounts can't submit test claims", that the test claim workflows are "only available for
    production accounts", that "Stedi infers the mode - test or production - from the API key type" (a test API key is
    required; a production key on a test endpoint returns HTTP 404), and that `usageIndicator`, if present, must be `T`
    (otherwise HTTP 403). So `ACCOUNT_NOT_PROVISIONED` on a sandbox key is probably expected, not a fault. We still ask
    Stedi to confirm this in writing and to say what we need to do (open a production account and create a test key).
15. Is `MDCKC` / `12M41` the right payer for Oregon hospice 837I and for NOE/NOTR (TOB 81A/81B, 82A/82B)?
    Our CCN is 381588 (Pendleton, OR 97801). Do NOE/NOTR use the same payer ID and the same 837I
    transaction?
16. What does enrollment for `12M41` require (CCN, NPI, PTAN, signed forms), and how long does it take?
    Can we test NOE/NOTR before enrollment completes?
17. Your docs say Original Medicare does not accept claim frequency 7 or 8 for resubmissions, yet your
    edit accepts them when `REF*F8` follows `CL1`. Does the MAC accept hospice adjustments (7) and
    cancels (8)? If not, what is the supported path?
18. Does your edit engine apply any hospice-specific rules (NOE timeliness, benefit-period dates,
    revenue-code/HCPCS pairing)? Our tests found none, and we treat our own validation as the gate.
19. Volume estimate (you asked): ADC 30-50; per month about 35-60 837I claims (incl. ~10% adjustments), 10-15 NOE, 10-15 NOTR, 25-45 eligibility checks; about 100-170 transactions in total.

Evidence for the technical call: payloads that pass your edits are in the session scratchpad
(`FINAL_837I_hospice_*`); synthetic data only.

## Follow-up questions (transport build, 2026-10-11)

These come from building the submit side against your sandbox. Each is something the code now depends on
an assumption for; we will not build wire behaviour on an unconfirmed answer. **Blocking** items gate
the receive side.

20. **(blocking)** Is there a documented validate-without-filing mode? We need to check a claim without it
    being filed or consuming the idempotency key. Does `usageIndicator: T` on a provisioned account
    never file? Do edits still run on an account that is not provisioned for the payer?
21. **(blocking)** NOE/NOTR use `BHT06 = RP` in our tests (`CH` with a $0 charge is rejected). Is `RP` the
    value a Medicare MAC expects for notices, or does it mean "not for adjudication" and risk the MAC
    ignoring the notice? Is a notice accepted on `CH` with any other shape?
22. **(blocking)** Webhook signatures: what exact content is signed? Your page words it as `timestamp.body`;
    the Standard Webhooks form is `id.timestamp.body`. How is the secret encoded (is a `whsec_` prefix
    stripped and the rest base64-decoded)? Which header names carry the id, timestamp and signature?
23. Claim routes: is the `Authorization` header the bare key or `Key <key>`? The 837I and 837P pages
    differ, and we have only seen the bare key work, on payer search and event destinations.
24. Idempotency: what does a replay return (same body, a marker header)? What does a reused key with a
    different body return?
25. Is the initial 277CA returned in the 200 body or delivered later (about 30 minutes)? Which STC codes
    mean "accepted by Stedi" versus "forwarded to the payer"?
26. What response shape means "provider not enrolled with this payer"? Payer search shows
    `ENROLLMENT_REQUIRED` for every Part A payer whether or not we are enrolled.
27. **(blocking)** On a shared account, how do we attribute an 835 or a 277CA to a tenant? Can polling
    results be filtered by billing NPI, or does each report carry a per-provider identifier?
28. If frequency 7/8 is refused for Medicare, how is a **paid** hospice claim adjusted or cancelled?
    Does your restriction cover TOB 8x7/8x8 at all?
29. Is claim status inquiry (276/277) available through the API for hospice institutional claims?
30. Is TOB 82A/82B and 8xC/8xD (transfer) accepted? Not yet exercised in the sandbox.
31. Why does NGS `MFPWU` show 837I `NOT_SUPPORTED` while Medicare Oregon Part A (`MDCKC`, `12M41`) does not?
    Which is correct for an Oregon hospice (CCN 381588)?

## Added 2026-10-25 (#727)

32. **(blocking, ADR-0053 D3)** ChartWarden is a software vendor serving many hospices (tenants). ADR-0053 D3 assumes one
    platform Stedi account holds the clearinghouse credential and the provider records (NPI, tax id, enrollments) of
    every tenant, with our own code keeping the tenants apart. Your integrated-account documentation
    ([overview](https://stedi.com/docs/healthcare/integrated-account-overview)) describes one Stedi account per provider
    connected through an OAuth app, as an alternative to "a single Stedi account to manage transactions and enrollments
    across all providers". May a reseller use one platform account with provider records, or must we use an integrated
    account per customer? If a single account is allowed: are there limits (number of providers, enrollments, BAA
    scope), and does an 835 or 277CA carry a per-provider identifier we can attribute to a tenant (see Q27)? If
    integrated accounts are required: who signs the BAA, who owns each provider's enrollments and billing, and how do a
    test key and the production key relate per integrated account? This decides whether D3 stands or needs a new ADR.
33. Is a BAA available for the account type we would use, and does it cover test-mode traffic? (No PHI or
    realistic claim data goes to the vendor without one.)

### Evidence and answer matrix (2026-11-16)

This matrix is a current audit index, not a claim that an email was sent. The send-ready message is still **not sent**.
`DOCUMENTED` means the cited public material describes the point; it does not mean MAC acceptance or ChartWarden-specific
approval. `RESOLVED` is used only where the existing 2026-10-09 Customer Operations reply answered the stated scope.
Public documentation reviewed 2026-11-16:

- [Test claims workflow](https://www.stedi.com/docs/healthcare/test-claims-workflow)
- [Test mode](https://www.stedi.com/docs/healthcare/test-mode)
- [Integrated Account overview](https://www.stedi.com/docs/healthcare/integrated-account-overview)
- [OAuth apps](https://www.stedi.com/docs/healthcare/oauth-apps) and [OAuth app setup](https://www.stedi.com/docs/healthcare/oauth-apps-setup)
- [Credentialing and enrollment](https://www.stedi.com/docs/healthcare/credentialing-and-enrollment) and [transaction enrollment requests](https://www.stedi.com/docs/healthcare/create-manage-transaction-enrollments)
- [Resubmit or cancel claims](https://www.stedi.com/docs/healthcare/resubmit-cancel-claims)
- [Retrieve 277CAs and 835 ERAs](https://www.stedi.com/docs/healthcare/receive-claim-responses)
- [Stedi BAA](https://legal.stedi.com/legal/baa-4a521009?v=1.1)

| ID | Decision affected | Existing public/vendor evidence | Provisional WardenX position | Vendor confirmation needed | Evidence location | Owner | Status |
|---|---|---|---|---|---|---|---|
| Q1 | Medicare payer routing | 2026-10-09 reply says Stedi generates envelopes and payer ID goes in 2010BB; sandbox payer search showed `MFPWU` unsupported for 837I. | No payer/MAC support inferred from envelope guidance. | Confirm hospice 837I payer IDs/MAC coverage. | This dossier; `STEDI_SANDBOX_FINDINGS_20261009.md` | Product + Stedi | AWAITING_VENDOR |
| Q2 | NOE/NOTR submission | Sandbox edits passed synthetic 81A/81B with BHT06 RP; no MAC acceptance evidence. | Edit acceptance is not filing/acceptance. | Confirm 837I API and MAC path for hospice notices. | Findings; send-ready Q16 | Product + Stedi/MAC | AWAITING_VENDOR |
| Q3 | Paid-claim corrections | Public resubmission docs distinguish Medicare and non-Medicare; sandbox edit accepts 7/8 with REF*F8. | Do not change billing behavior from generic guidance or edit results. | Explain rejected versus adjudicated hospice correction/void path. | Send-ready Q17/Q28 | Product + Stedi/MAC | AWAITING_VENDOR |
| Q4 | Transfer notices | No tested or cited transaction-specific support. | 8xC/8xD remain unverified. | Confirm transaction and MAC routing support. | Findings Q30 | Product + Stedi/MAC | AWAITING_VENDOR |
| Q5 | Claim/ERA enrollment scope | Public enrollment docs describe payer + provider + transaction enrollment; payer data had PTAN requirement. | Do not infer Medicare hospice enrollment unit from generic pages. | Confirm MAC/hospice enrollment identifiers, scope, and timing. | Send-ready Q16 | Product + Stedi | AWAITING_VENDOR |
| Q6 | Notice enrollment | No documented hospice-specific answer. | Treat notice enrollment as unknown separately from claim/ERA. | Confirm if NOE/NOTR require distinct enrollment. | Send-ready Q16 | Product + Stedi/MAC | AWAITING_VENDOR |
| Q7 | Tenant authentication model | Integrated Account docs describe account per provider/practice; OAuth guide says private preview and asks developers to contact Stedi. | ADR-0053 selects per-tenant vendor configuration; OAuth approval is not assumed. | Confirm ChartWarden eligibility, approval, and tenant-account arrangement. | Send-ready Q32 | Product + Stedi | AWAITING_VENDOR |
| Q8 | 277CA/999 handling | 2026-10-09 reply says 999, Stedi 277CA, payer 277CA and 835 arrive as transaction events; public docs describe initial 277CA. | Preserve stage and source distinctions. | Clarify hospice/MAC timing where needed. | Existing answer; `STEDI_TRANSPORT_CONTRACT_20261011.md` | Engineering + Stedi | DOCUMENTED |
| Q9 | Event signatures/delivery | 2026-10-09 reply provides reference-only payloads, signing secrets, polling reconciliation; public event docs describe delivery. | Use documented event contract; no live delivery observed. | Resolve any remaining signature-format discrepancy before adapter reliance. | Existing answer; transport contract Q22 | Engineering + Stedi | AWAITING_VENDOR |
| Q10 | Poll recovery | 2026-10-09 reply recommends poll transactions endpoint for missed events. | Poll reconciliation is part of the design. | Confirm no unresolved endpoint/account-scope details. | Existing answer; transport contract | Engineering + Stedi | RESOLVED |
| Q11 | Medicare eligibility | 2026-10-09 reply identifies HETS and CORE options, per-NPI CMS enrollment/attestation handled by Stedi, X-Forwarded-For and U.S. origin constraints. | Apply only to eligibility scope stated in reply. | No additional reply needed for that scope. | Existing answer in this file | Product + Stedi | RESOLVED |
| Q12 | Synthetic test/certification | Public docs now say test claims to any payer return test 277CA; Stedi Test Payer can return test 277CA + 835. | Synthetic test is not MAC certification or payer acceptance. | Confirm hospice-specific certification/pilot expectations. | Test claims workflow; send-ready Q14/Q16 | Product + Stedi | DOCUMENTED |
| Q13 | Duplicate safety | Existing transport contract records documented 24-hour Stedi idempotency and a permanent local attempt guard. | Keep local idempotency authority. | No extra answer unless Stedi changes its published terms. | `STEDI_TRANSPORT_CONTRACT_20261011.md` | Engineering | DOCUMENTED |
| Q14 | Test claim account and responses | Public docs: Sandbox cannot submit claims; a Production account uses Test-mode keys; Test mode does not route claims to payers; Test Payer ERA requires a provider enrollment created outside test mode. | Existing contract test is transport-only and must use Test key/`ISA15=T`; no production key or OAuth call. | Confirm account provisioning/applicability to ChartWarden and synthetic enrollment requirements. | Send-ready Q14; runbook | Product + Stedi | AWAITING_VENDOR |
| Q15 | Oregon hospice payer ID | Earlier payer-search observation is not payer/MAC confirmation. | `MDCKC` / `12M41` remains a candidate only. | Confirm Oregon hospice claims/notices/ERA and NGS alternative. | Findings; send-ready Q16 | Product + Stedi/MAC | AWAITING_VENDOR |
| Q16 | Medicare Part A/Hospice enrollment | Generic docs describe transaction enrollment and typical timelines, but no hospice MAC-specific provider unit or PTAN answer. | Ask separately for 837I, notices, ERA, NPIs, CCN/PTAN, MAC, and transition. | Written MAC/hospice enrollment workflow and evidence. | Send-ready Q16 | Product + Stedi | AWAITING_VENDOR |
| Q17 | Frequency 7/8 replacements | Public Medicare guidance says institutional claims resubmit with original CFC; sandbox accepting 7/8 is only an edit observation. | No universal policy inferred; rejected and paid claims are separate. | Clarify paid hospice corrections/cancels and FISS/DDE. | Send-ready Q17/Q28 | Product + Stedi/MAC | AWAITING_VENDOR |
| Q18 | Hospice edit coverage | Synthetic sandbox probes found no hospice-specific edits; no comprehensive published claim. | WardenX validation remains independently required. | State hospice-specific edit coverage and limitations. | Findings; send-ready Q16 | Engineering + Stedi | AWAITING_VENDOR |
| Q19 | Volume forecast | Existing dossier contains a WardenX estimate supplied in response to Stedi's request. | Retain as an estimate, not observed usage. | None unless Stedi requests an updated estimate. | This file, Q19 | Product | DOCUMENTED |
| Q20 | Validate-without-filing | Test mode is documented as non-payer-routed; no separate validate-only endpoint confirmed for production use. | Never use a production submission as a dry run. | Confirm any non-filing validation mode and account provisioning behavior. | Send-ready Q14; transport contract | Engineering + Stedi | AWAITING_VENDOR |
| Q21 | NOE/NOTR BHT06 | Sandbox observation: RP passed edits and CH with zero charge rejected. | Edit pass does not establish MAC filing; preserve hold pending evidence. | Confirm correct hospice notice value and MAC acceptance path. | Findings; send-ready Q16 | Product + Stedi/MAC | AWAITING_VENDOR |
| Q22 | Event signature bytes | Existing public docs and Standard Webhooks interpretation conflict in signed-content detail; no delivery observed. | Do not treat synthetic local signature as vendor proof. | Confirm exact signed bytes, secret encoding, and headers/sample. | Transport contract Q22 | Engineering + Stedi | AWAITING_VENDOR |
| Q23 | Claim authorization header | Public API docs describe API key header forms, but integration route behavior not live-observed for our use. | Preserve current adapter assumption pending live test. | Confirm exact 837I endpoint auth format. | Transport contract; send-ready follow-up | Engineering + Stedi | AWAITING_VENDOR |
| Q24 | Idempotency response | Public docs describe key use/lifetime; no successful Stedi 200/replay observed. | Local permanent attempt store remains authoritative. | Confirm replay and conflicting-body response shape. | Transport contract | Engineering + Stedi | AWAITING_VENDOR |
| Q25 | Initial/later 277CA stage | Public docs describe synchronous initial Stedi 277CA and later responses via event/polling. | Do not equate Stedi receipt with payer acceptance. | Confirm any hospice-specific response timing/status mapping. | Receive responses docs; transport contract | Engineering + Stedi | DOCUMENTED |
| Q26 | Not-enrolled signal | Payer search `ENROLLMENT_REQUIRED` is not an observed runtime not-enrolled response. | Never infer enrolled state from payer metadata alone. | Provide actual response shape and recovery workflow. | Transport contract | Engineering + Stedi | AWAITING_VENDOR |
| Q27 | Tenant attribution | Integrated Account docs describe account-scoped credentials/activity; no ChartWarden-specific callback/report proof. | Bind each response to the tenant account and verify identity before handling. | Confirm stable account/provider identifiers in every response channel. | Send-ready Q32 | Engineering + Stedi | AWAITING_VENDOR |
| Q28 | Correction/cancel and FISS/DDE | Same generic Medicare guidance as Q17; no hospice-specific paid-claim workflow evidence. | Rejected resubmission, replacement, void, adjustment, and DDE stay distinct. | Written MAC workflow, including TOB 8x7/8x8 applicability. | Send-ready Q17/Q28 | Product + Stedi/MAC | AWAITING_VENDOR |
| Q29 | 276/277 claim status | Public/API support and implemented path do not prove hospice payer availability or MAC coverage. | Do not use status lookup to infer “not found” or retransmit. | Confirm hospice 276/277 transaction support and response scope. | Transport contract Q29 | Engineering + Stedi | AWAITING_VENDOR |
| Q30 | TOB 82A/82B and 8xC/8xD | Synthetic edits passed some forms; payer/MAC routing not tested. | No routing or acceptance claim. | Confirm each transaction separately by MAC. | Send-ready Q16; findings Q30 | Product + Stedi/MAC | AWAITING_VENDOR |
| Q31 | NGS versus Oregon route | Payer-search observation only. | No Oregon payer conclusion from generic NGS record. | Confirm correct payer routing for the stated hospice/MAC. | Send-ready Q16 | Product + Stedi/MAC | AWAITING_VENDOR |
| Q32 | Per-tenant Stedi accounts/OAuth | ADR-0053 (2026-11-06) decides tenant-selected clearinghouse and tenant-held config/credential/BAA. Public Integrated Account docs describe account per provider/practice; OAuth docs say private preview/contact Stedi. | Architecture decision is not open; Stedi availability, approval, multi-provider account scoping, response isolation, billing, disconnect, and test behavior are open. | Confirm a supported Stedi model for ChartWarden's tenant-owned choice; do not assume reseller approval. | Send-ready Q32; ADR-0053 amendment | Product + Stedi | AWAITING_VENDOR |
| Q33 | BAA and responsibilities | Public Stedi BAA exists; this does not determine each tenant's signer, ChartWarden's app-provider BAA, or OAuth account responsibility. | Legal/compliance approval is separate from engineering readiness. | Confirm signer(s), scope, subprocessors, enrollments, credential control, audit, retention, and revocation. | Send-ready Q33; public BAA | Legal/Compliance + Stedi | AWAITING_VENDOR |

The old Q32 text immediately above is retained as historical 2026-10-25 wording only. It is **superseded** by the
tenant-choice framing in the send-ready document and ADR-0053 amendment; it must not be sent as written.
