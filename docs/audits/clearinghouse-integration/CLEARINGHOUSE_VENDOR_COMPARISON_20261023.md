# Clearinghouse comparison: Claim.MD and Stedi against `ClearinghouseTransport`

**Date:** 2026-10-23 · **Status:** documentation review, **no account was opened and no call was made**. Facts come from
the vendors' public documentation and pricing pages as fetched on 2026-10-23; each is the vendor's statement, not a test
result. "Not stated" means the pages read did not say, not that the answer is no. Several Claim.MD pages link to a separate
API reference (`api.claim.md`), which was read; a few detail pages were not.

Context: [ADR-0053](../../adr/ADR-0053-clearinghouse-transport-port.md) (port, two-stage acks, conformance),
[`STEDI_SANDBOX_FINDINGS_20261009.md`](./STEDI_SANDBOX_FINDINGS_20261009.md) (the repo's own Stedi probe),
[`STEDI_QUESTIONS_20261008.md`](./STEDI_QUESTIONS_20261008.md), and the billing plan
[`../billing-e2e/IMPLEMENTATION_PLAN_20261023.md`](../billing-e2e/IMPLEMENTATION_PLAN_20261023.md) Track 4 (issues 14, 15, 24).

## 1. Claim.MD - what the documentation says

| Area | Finding |
|---|---|
| Access | Base `https://svc.claim.md` (the old `www.claim.md` host was retired in June 2024). Each request carries an `AccountKey` form field; the key is per account and an admin generates it after re-entering their password. Test and production use the **same host**, with a different key; enrollments and the enrollment webhook must be set up again in production |
| Claim upload | `POST /services/upload/` accepts 837I and 837P X12, XML, CSV/XLS(X), JSON, NSF and others; 1-2,000 claims per call. The upload response returns a per-claim status and messages. Institutional JSON is not shown (the JSON example is professional). Duplicate-submission behaviour is **not stated** |
| Hold-for-approval | By default uploaded claims **wait for approval** in the portal; the account setting "Transmit Approval" must be switched off for automatic sending. A claim that is uploaded but not transmitted is a false-success risk for the adapter |
| Claim responses | Polled with `POST /services/response/` using a cursor (`ResponseID`, up to 20,000 per call). **No 999 is returned**; rejections arrive per claim. 277CA is **not stated**; 277 is available through SFTP only. The meaning of the status codes was not in the pages read |
| Remittance | `eralist` then `era835` (X12), `erapdf`, `eradata` (XML/JSON), cursor `ERAID`. ERAs are **not matched to claims automatically**; the integrator matches on patient control number, member id, dates and codes. An ERA "can only be returned to one clearinghouse". ERA enrollment takes 3-30 days |
| Eligibility | `POST /services/elig/` (one 270 per request, real time) and `/eligdata/`. Eligibility enrollment is per payer. A guide on HETS Medicare attestation exists. The test system returns one sample response regardless of input |
| Webhooks | Only **enrollment and appeal** events (JSON POST). ERA and claim events are not pushed, so claims and ERAs are poll-only. Signature `Auth-Signature-Base64` is an HMAC-SHA256 of the raw body keyed with the API key; delivery is at least once, retried for up to four days; dedupe on `acct_number` plus `eventid` |
| Provider enrollment | `POST /services/enroll/` returns a one-time URL to show the provider; one provider at a time; bulk and required fields not stated. Credentialing with the payer must come first; provider validation uses NPPES contact details |
| Multi-provider model | One account can bill for several organizations, each added as a provider record. "Vendor Settings" lets an admin link a software vendor to an account with an access level (No, Limited, All Support, Full). A **platform-with-many-customers model is not documented** in the pages read |
| Institutional / hospice | The facility form is the electronic UB-04 mapped to 837I loops. Type-of-bill values listed are 11, 13 and 18 with frequency 1, 7, 8. **Hospice (081x) is not mentioned**; raw 837I upload may pass it through, but that is unverified. Corrections use frequency 7 and voids 8 with the payer ICN in REF F8 |
| Limits | 100 requests per minute, then a temporary block and HTTP 403; attachments up to 10 per claim, 16 MB each; payer response normally under 20 seconds; eligibility times out at 90 seconds |
| Test mode | Policy number `REJECT` forces a rejection and `DENY` forces a denial on the test ERA; test and production share endpoints |
| Pricing (website) | Basic $30/month with $0.30 per claim, ERA and eligibility; Small Volume $60/month including 100, then $0.50; Unlimited $120/month with unlimited claims and ERAs and 1,000 eligibility checks. No setup fee and no per-provider fee. Attachments $0.60. Some fees for additional billing tax ids are unclear. **API or software-vendor pricing is not stated** ("enterprise" and "integrated vendors" are mentioned). The pricing page showed a "Server Unavailable" banner, so it may be incomplete |
| BAA | Not stated |

## 2. Stedi - what the documentation adds to the repo's own findings

| Area | Finding |
|---|---|
| Pricing | Pay as you go, no monthly minimum, no per-provider or per-payer fee. 837: $0.30 for the first 500 a month, then $0.20, $0.12, $0.10. 835: $0.20 per adjudicated claim, then $0.15, $0.10, $0.08. 270/271 and 276/277: $0.30 down to $0.08. **277CA: free.** Attachments $0.75. Transaction enrollment API free. Payer-imposed fees are billed at cost. Sandbox is free |
| Test claims (closes Q14 in part) | Test claims are available **only on production accounts** with a test key (or ISA15 `T`). The repo's `ACCOUNT_NOT_PROVISIONED` on a sandbox key is therefore expected, not a defect. Enrollment with the **Stedi Test Payer** must be submitted in production; then member-id prefixes (`STEDI_PAID_`, `STEDI_PARTIALLY_PAID_`, `STEDI_DENIED_`) drive a test 277CA and 835. Stedi still needs to confirm this in writing |
| Enrollment | Per clearinghouse. Typically 24-48 hours, up to 30 days; per NPI or per TIN depends on the payer; **835/ERA enrollment is required by all payers**; 837 and eligibility depend on the payer. Medicare, Medicaid and hospice specifics are **not stated**. Credentialing (90-180 days) and payer enrollment (60-120 days) are the provider's job, not Stedi's |
| Multi-customer model | **Integrated accounts**: each provider or practice gets its own Stedi account, linked to the platform through an OAuth app (new apps must use OAuth). Credentials are scoped per account, which isolates enrollments and transactions. This differs from the "platform holds one credential, tenants scoped by our code" assumption in ADR-0053 D3. Whether a single platform account with provider records is acceptable for a reseller is **an open question for Stedi** |
| Acknowledgments | Synchronous 277CA in the submit response, later payer 277CAs; 999 only over SFTP (repo finding) |

## 3. Side by side against the transport port

| Port need (ADR-0053) | Stedi | Claim.MD |
|---|---|---|
| `submitClaim` hospice 837I | Edits pass in test; payer support is per payer (NGS hospice 837I shown unsupported, state Part A payers need enrollment) | 837I X12 accepted; **hospice acceptance not stated**, approval hold must be off |
| `submitNotice` NOE/NOTR (81A/81B) | Raw X12 passes edits with `BHT06=RP`; real payer acceptance unknown | Not stated |
| Two-stage acks (D2) | Clearinghouse stage in the sync 277CA, payer stage later; 999 not needed for API | No 999, no stated 277CA; payer stage unclear |
| Durable idempotency (D6) | `Idempotency-Key`, 24 hours; repo keeps its own attempt store | **Not stated**; the attempt store is mandatory |
| Push events (D7) | Standard Webhooks, references only, retries 48 hours | Enrollment and appeal only; claims and ERAs are poll-only |
| `fetchRemittances` | Reports and polling endpoint, plus events | Cursor polling; manual matching |
| Tenant boundary (D8) | Integrated accounts give a vendor-side boundary (if adopted) | One key sees all providers on the account: the adapter **must filter every response and ERA by billing NPI and tax id** and prove it in a conformance case |
| Eligibility | 270/271 and mock requests | Real-time 270, per-payer enrollment |
| Cost at about 100-170 claims a month per tenant | About $0.20-$0.30 per claim plus $0.20 per 835 claim | Flat $30-$120 a month per account plus per-item fees; per-tenant economics depend on the account model |

## 4. Assessment

- **Claim.MD is a credible second adapter** on cost and a documented HTTP API with cursor polling for responses and ERAs.
- It is **not ready to build against** until four things are answered in writing (status 2026-10-23: duplicate handling is
  settled by design, and the other three have user-supplied answers awaiting vendor confirmation, section 6): (1) does the clearinghouse accept hospice
  institutional claims (type of bill 81x) and notices; (2) what do the response statuses mean, and is the payer stage
  distinguishable from the clearinghouse stage; (3) what is the multi-customer model for a software platform and how are
  tenants isolated on one key; (4) how are duplicate uploads handled.
- **Stedi's multi-customer model needs a decision** (integrated accounts versus one platform credential) before the first
  production tenant, because it changes who owns each provider's account and enrollments.
- Neither vendor's documentation says anything about hospice-specific payer rules; those stay in ChartWarden's validation.

## 5. Questions to send

**Claim.MD:** hospice 837I (TOB 811-814 and NOE/NOTR 81A/81B) acceptance and payer list for hospice; meaning of every response
status and whether a payer-stage acknowledgment is returned; whether a 277CA is available through the API; platform
(software vendor) account model, per-provider isolation and API pricing; duplicate-claim handling on upload; whether an
account can disable "Transmit Approval" by API; BAA availability; sandbox limits.

**Stedi:** written confirmation that test claims need a production account; enrollment unit for Medicare Part A hospice
(NPI, entity or TIN) and lead time; whether a reseller may use one platform account with provider records instead of an
integrated account per customer; Medicare frequency 7/8 replacements (Q17); NOE/NOTR channel for Original Medicare.

## 6. Answers received 2026-10-23 (user-supplied, not vendor-confirmed)

The product owner pasted answers to the four blocking Claim.MD questions. The source of the text is not shown, so treat each
as an unconfirmed claim until Claim.MD says it in writing.

| Question | Answer received | What it settles | What stays open |
|---|---|---|---|
| Accepts hospice institutional claims and notices? | "Yes" (no evidence supplied) | Nothing yet. The documentation read does not mention hospice (081x) or NOE/NOTR | Written confirmation, plus which payers accept hospice 837I through Claim.MD |
| Response statuses and payer-stage visibility | `POST /services/response/` returns later updates with sender identity, response time, status, messages and claim ids; the example shows one acknowledgment from Claim.MD and one from an external sender | Plausibly separates clearinghouse stage from payer stage by sender | Full status code list, and a recorded sample of a payer-stage response, before mapping onto ADR-0053 D2 |
| Multi-customer model, one key sees all providers | Responses carry billing NPI, tax id, payer id, Claim.MD claim id and our own claim id; enrollment is per provider; webhooks carry account ids. Recommendation: one secured integration service, key only in backend secrets, one account-wide polling cursor distributed internally by tenant, map every external id to exactly one tenant and claim, match on authoritative ids and verified provider identity, quarantine unmatched or conflicting responses, billing companies see only agencies that authorized them | This is a design recommendation, not a vendor statement. It agrees with ADR-0053 D8 | Claim.MD's confirmation that a platform account may serve many unrelated agencies, and its API pricing |
| Duplicate uploads | No published guarantee that a resent file is rejected; do not rely on undocumented behaviour. Two problems: duplicate transmission (timeout then resend) and duplicate billing (a second claim for the same period) | Confirms our assumption in section 3 | Nothing; build to this |

Design consequences for an adapter, whichever vendor:
- Reserve a durable submission attempt first (claim-version id, payload hash, attempt id), send, store the vendor claim id.
- A timeout is **unknown**, not failed. Reconcile through the uploaded-file list (`/services/uploadlist/`) and the response
  records before any resend; resend only on evidence the first attempt was not accepted, or by a manual decision. This is the
  existing attempt-store behaviour (ADR-0053 D6).
- Duplicate billing is a separate control: check billing history and force the correction or replacement workflow
  (frequency 7 or 8 with the payer claim number) instead of a second original.
- Cross-tenant matching is proven in a conformance case: a response or ERA that cannot be tied to exactly one tenant and
  claim is quarantined and posts nothing.
