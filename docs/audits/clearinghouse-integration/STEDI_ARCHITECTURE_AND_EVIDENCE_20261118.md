# Stedi evidence, target architecture and readiness plan

**Reviewed:** 2026-11-18
**Scope:** documentation and planning only. This document records no Stedi API call, account action, vendor approval or qualification result.

## Evidence classes

Use multiple labels when a statement has more than one provenance. A source label does not itself satisfy a separate qualification gate.

| Class | Meaning |
|---|---|
| `MAINTAINER_REPORTED` | Account or discussion information supplied by the ChartWarden maintainer; not a vendor-written record. |
| `PUBLICLY_DOCUMENTED` | Current official public documentation describes the behavior, but does not prove account-specific enablement or MAC acceptance. |
| `VENDOR_WRITTEN_CONFIRMED` | Account-specific written Stedi confirmation retained in the dossier. Only the 2026-10-09 Customer Operations reply qualifies today, and only for its stated scope. |
| `ARCHITECTURE_DECIDED` | Internal ChartWarden decision, including ADR-0053. |
| `LOCAL_TEST_VERIFIED` | Local, fixture, mocked or synthetic test evidence. |
| `VENDOR_TEST_VERIFIED` | Observation from a separately authorized Stedi Test-mode run. |
| `MAC_VERIFIED` | Applicable MAC-specific qualification evidence. |
| `AWAITING_VENDOR` / `AWAITING_LEGAL` | Written vendor or contractual/legal decision remains outstanding. |

The October 9 reply and sandbox findings remain historical evidence in [`STEDI_QUESTIONS_20261008.md`](./STEDI_QUESTIONS_20261008.md), [`STEDI_WRITTEN_MESSAGE_20261011.md`](./STEDI_WRITTEN_MESSAGE_20261011.md), and [`STEDI_SANDBOX_FINDINGS_20261009.md`](./STEDI_SANDBOX_FINDINGS_20261009.md). Do not reinterpret old `O` edit observations as submission or payer acceptance. No new account-specific written Stedi reply or authorized Test-mode run has been added in this lot.

## Consolidated answers and boundaries

| Topic | Current record | Evidence class | What remains gated |
|---|---|---|---|
| Q14 account and Test mode | ChartWarden already has a Stedi Production account. Synthetic claim/notice contract requests use a separate Test-mode API key; Stedi says Test-mode transactions do not route to actual payers. Synthetic 277CA is supported but ChartWarden has not retrieved one. Synthetic 835 generation requires provider registration/enrollment with the Stedi Test Payer for the applicable claim-payment transaction. That enrollment is set up outside Test mode; subsequent synthetic submissions use Test credentials. This setup is not Medicare enrollment and does not redirect a real provider's ERA. The current contract run does not require Test Payer ERA enrollment unless it adds an 835 scenario. | `MAINTAINER_REPORTED`, `PUBLICLY_DOCUMENTED`; prior `LOCAL_TEST_VERIFIED` refusal only | Written account authorization/applicability, independent Test-key verification, successful JSON and raw-X12 submissions, 277CA retrieval; separately authorized Test Payer enrollment and 835 retrieval. **No successful Stedi submission is evidenced.** |
| Q27/Q32 tenant accounts and OAuth | Each hospice may own its Stedi account; the maintainer reports OAuth/Integrated Accounts as the recommended model for new partner apps, one organization account may represent multiple providers under Stedi's supported model, and Stedi provides account-level isolation. ChartWarden must still enforce tenant and provider isolation. | `MAINTAINER_REPORTED`, `PUBLICLY_DOCUMENTED`, `ARCHITECTURE_DECIDED` | ChartWarden's OAuth partner approval, supported provider/account cardinality, stable attribution identifiers and event/poll isolation remain unconfirmed. |
| B5 commercial model | Provisional recommendation: each tenant pays its own clearinghouse directly; no centralized transaction billing in ChartWarden initially. Consolidated partner billing may be revisited. Stedi publicly documents pay-as-you-go and custom plans, with consolidated billing for Integrated Accounts on custom plans; this is not a commercial offer or agreement to ChartWarden. | `MAINTAINER_REPORTED`, `PUBLICLY_DOCUMENTED`, `ARCHITECTURE_DECIDED` (provisional) | Stedi commercial terms and availability. This does not block technical development. |
| B6 switch/disconnect lifecycle | Preserve immutable vendor/configuration provenance. Do not resubmit payer-accepted claims. Reconcile uncertain outcomes before any retry. Correct definitively rejected claims only through an authorized route. Revocation may remove access to pending/history responses; ERA delivery follows payer enrollment and effective transition rules. A future lifecycle should distinguish active, draining/reconciliation-only (if access remains), revoked/disconnected, and outstanding items needing manual reconciliation. No token is assumed usable after revocation and MAC/payer transitions are not assumed uniform. | `MAINTAINER_REPORTED`, `ARCHITECTURE_DECIDED` | Vendor-specific revocation, retrieval retention and ERA cutover behavior; implement as separate lifecycle work. |
| Q16 Medicare hospice routing/enrollment | General model: HETS is the national Medicare FFS 270/271 route; institutional claims/notices use the applicable HH+H MAC; ERA goes to the applicable enrolled payer/MAC; 276/277 is payer-specific. Find and verify payer records against current Stedi payer data and CMS HH+H jurisdiction assignment. Oregon is in the NGS HH+H jurisdiction on the current CMS map; this does **not** prove historical `MDCKC` / `12M41` is the correct hospice payer record. Enrollment generally involves billing NPI, TIN, applicable PTAN and/or CCN, provider authorization/attestations, transaction-specific enrollment, provider actions, payer/MAC approval, and status retrieval. Do not equate PTAN and CCN globally or promise a fixed approval SLA. Maintainer reports NOE/NOTR use the institutional claim transaction family; payer-specific notice format/enrollment remains open. Raw-X12 edit acceptance does not establish JSON notice support. | `MAINTAINER_REPORTED`, `PUBLICLY_DOCUMENTED` | Account/payer/MAC-specific routing, enrollment requirements/status and NOE/NOTR details; separate Medicare enrollment from Stedi transaction enrollment, contract test, and MAC qualification. |
| Q17/Q28 adjustments and voids | Stedi's general Medicare resubmission guidance describes original frequency for applicable resubmissions. CGS describes hospice 817/827 adjustments and 818/828 cancels in its HH+H FISS/DDE guidance. These cover different workflow scopes and do not establish Stedi API support for paid hospice adjustments/cancels. Keep Stedi 7/8 replacement/void fail-closed; retain 7/8 in general billing domain; a tracked external correction/reconciliation path may be developed. | `PUBLICLY_DOCUMENTED`, `LOCAL_TEST_VERIFIED` (edit acceptance only), `ARCHITECTURE_DECIDED` | Complete Stedi answer and applicable MAC evidence required before enabling those submissions. Rejected pre-adjudication correction, in-adjudication, paid adjustment, cancellation, and external FISS/DDE correction remain distinct. |
| Q33 BAA/contracts | Proposed model: hospice owns its vendor account and applicable vendor agreement; ChartWarden maintains its own applicable business-associate obligations; whether ChartWarden also needs a direct Stedi agreement is for legal/contract review. Public BAA availability does not decide signer, scope or app-provider obligations. | `MAINTAINER_REPORTED`, `PUBLICLY_DOCUMENTED`, `AWAITING_LEGAL` | Account-specific BAA/terms and legal approval. Synthetic development may continue; production PHI exchange and customer activation remain gated. |

## OAuth / Integrated Account target

ADR-0053's 2026-11-06 amendment is authoritative: each tenant chooses `stedi`, `claimmd`, or `outside`, and owns its clearinghouse relationship and sealed credential. The older accepted D3 paragraph describing one platform credential is superseded for tenant-selected connections; the env binding is now a documented fallback for explicitly configured legacy organizations. See ADR-0053's amendment for the implemented configuration, resolver, BAA record, activation, and switching controls.

Target direction for a future Stedi OAuth application:

```text
tenant selects Stedi
  → tenant administrator authorizes ChartWarden's registered OAuth app
  → protected callback validates one-time state and PKCE verifier
  → returned Stedi account is bound to the tenant and recorded by a stable vendor identity
  → credentials/tokens are encrypted and tenant-scoped
  → transport is constructed for that tenant and authorized account
  → provider/entity and transaction enrollment gates are checked
  → submissions and fetched responses are attributed and checked against tenant, account, provider, and attempt provenance
```

Implementation design constraints:

- Require an authorized tenant administrator, explicit consent, audited actor/tenant/account binding, and replay-resistant callback state. Stedi's public guide describes OAuth 2.1 authorization-code + PKCE, storing the verifier server-side, unique unguessable state, validating state before exchange, and a one-time code with a short exchange window. Use a maintained OAuth client; do not invent endpoint payloads.
- Bind a vendor-returned stable external account identity (the public guide names `stedi_account_id`) to one tenant connection. The exact account/provider relationship and stable response identifiers need written confirmation where docs do not state them.
- Encrypt client/refresh credentials at rest using the established tenant secret boundary. Define token refresh locking/concurrency, least-privilege scopes, key rotation, revocation, uninstall and credential-erasure behavior from the full Stedi integration guide before implementation. Do not assume token validity after uninstall or revocation.
- Keep tenant isolation in ChartWarden even where Stedi supplies account-level isolation: tenant-bound transport, provider-bound submission provenance, account-scoped event/poll readers, strict response correlation, and quarantine on mismatch or ambiguity.
- Treat event destinations as tenant-owned or explicitly account-bound; authenticate signatures and replay before resolving any event reference. Preserve polling as reconciliation, and retain source account/config identity on every attempt and response.
- For multiple providers within one account, keep provider entity, NPI/TIN/Medicare identifiers and transaction enrollment distinct; account membership does not itself authorize every provider or transaction.
- Clearinghouse switching uses ADR-0053's controls. Outstanding/ambiguous attempts are reconciled under their original account where access permits; no automatic resubmit of accepted or uncertain claims. If an account is revoked, stop requests and expose unreconciled work for operator handling.
- OAuth app registration/approval and access to Stedi's complete integration guide are not obtained or presumed in this documentation increment.

Keep the three paths separate:

1. **Existing API-key transport:** implemented and resolved per tenant from tenant-owned configuration; some capabilities still return `CH_NOT_WIRED` or remain vendor-unverified.
2. **Synthetic qualification:** the existing dedicated Test-key contract runner remains the path for an authorized synthetic Test-mode run; it is not replaced by customer OAuth.
3. **Customer onboarding target:** OAuth/Integrated Accounts is a future implementation. An OAuth production account is not equivalent to a Test-mode key, and OAuth is not enabled by this design document.

### Runtime/comment drift noted

- [`stedi-transport.ts`](../../../packages/x12-837-client/src/clearinghouse/stedi-transport.ts#L125) `createStediTransportFromEnv` explicitly reads `STEDI_API_KEY`; this remains the platform-env fallback factory and is not the tenant credential resolver.
- [`clearinghouse-binding.ts`](../../../apps/backend/src/modules/23-billing-medicare/clearinghouse-binding.ts#L1) still opens by describing the platform-bound vendor as the clearinghouse choice under ADR-0053 D3. That header is stale as a general architecture statement: D3 was superseded for ordinary tenant traffic by the 2026-11-06 amendment. The platform binding still exists for specifically listed fallback organizations.
- [`tenant-clearinghouse/resolver.ts`](../../../apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/resolver.ts#L182) resolves each organization row, builds/caches a binding from that row, and keeps the top-level binding deliberately unbound. ADR-0053 and this resolver—not the old header comment—describe current tenant selection behavior.
- [`apps/backend/src/index.ts`](../../../apps/backend/src/index.ts#L11598) records tenant-account references as `tenant:<organizationId>` and the platform Stedi account as `platform:stedi`; this supports internal attempt provenance but does not prove Stedi supplies those same identities in callbacks or response payloads.

These locations are recorded as documentation drift; this lot intentionally makes no production-code cleanup.

## Development and activation matrix

| Capability | Engineering now? | Local test | Stedi Test mode | Evidence/dependency before production activation |
|---|---|---|---|---|
| OAuth foundations | Yes, after a scoped design and without registering an app | Yes: state/PKCE/callback, tenant binding, revocation and concurrency mocks | No until Stedi approves the app/model | Partner approval, exact integration guide, scopes, account identity and legal/compliance gates |
| Integrated Account onboarding | Partial; build behind an unbound/fail-closed adapter | Yes with fake OAuth/account provider | Not proven available for Test-mode OAuth | Account cardinality, tenant authorization, stable account identity, uninstall behavior and vendor approval |
| Tenant credential lifecycle | Existing tenant config/secret sealing, verification, BAA, activation and switching are wired; OAuth token lifecycle is not | Existing local tests plus future OAuth-token tests | API key contract only | Tenant-specific written authorization, token/revocation behavior and legal gate |
| Provider records | May develop internal provider linkage and validation | Yes | Account-specific provider mutations require approved test path | Required identifiers, provider cardinality, authorization and enrollment semantics |
| Payer directory | May develop discovery/cache and manual verification | Yes using fixtures | Directory calls are documented API behavior but account authorization still applies | Validate current payer record for each MAC, transaction type and provider; no payer record alone authorizes routing |
| Enrollment synchronization | May implement typed status/read model, fail closed | Yes with status fixtures | Enrollment API is not available in Test mode per test-mode docs | Correct provider, payer, transaction, forms/attestations, approval and status semantics |
| JSON and raw-X12 837I claims | Implemented; runtime uses Stedi JSON for eligible claim path and raw transport remains available | Mapper/transport/M23 tests | Authorized synthetic requests only; no successful run evidenced yet | Q14 authorization, payer/MAC route and enrollment, approved BAA/production gates |
| NOE/NOTR | Builders exist; current Stedi notice path is held/fail-closed | Yes with synthetic X12 and mocks | Contract suite covers NOE, not vendor-qualified; NOTR remains local/fake only | Written payer/MAC notice format, BHT06, enrollment/routing and actual acceptance evidence |
| 999/277CA ingestion | Port/workers and parsers are partly implemented; Stedi fetch/receive support is not fully wired/qualified | Yes with local response fixtures | 277CA synthetic retrieval remains unrun | Event/poll identifiers, signature contract, account/provider attribution, successful retrieved response and MAC stage mapping |
| 835 ERA retrieval | M25 receive/post path exists; Stedi `fetchRemittances` is not implemented in adapter | Yes with local ERA fixtures | Requires Test Payer provider enrollment for synthetic ERA | Test Payer enrollment and successful retrieval; production payer enrollment, BAA and posting reconciliation |
| Webhook signature verification | Port supports event verification; Stedi adapter is not wired for this capability | Yes with synthetic signatures | Requires authorized event destination and delivery | Written resolution of signed-byte discrepancy, vendor delivery, per-account secret lifecycle and replay behavior |
| Polling/reconciliation | Worker framework and durable cursors exist; Stedi pull methods remain unavailable | Yes with fake transport | Test retrieval account must be provisioned | Account-scoped API behavior, retention window, stable identifiers, missed-event reconciliation |
| Claim status 276/277 | Stedi method exists but endpoint/fields/status mapping are vendor-unverified | Yes with fixtures | Authorized account and payer support required | Payer-specific hospice support and response semantics; never infer not-found means safe to resubmit |
| Medicare HETS eligibility | Existing eligibility transport is not proof of Stedi HETS route readiness | Yes with synthetic/mock 271 | Test-mode mock results only | CMS/HETS authorization, provider attestation, U.S. request-origin and Stedi account-specific path |
| Frequency 7/8 paid adjustments/voids | General billing can evolve; Stedi remains held | Yes for domain/reconciliation states | Do not transmit via Stedi | Written Stedi guidance plus applicable MAC-specific acceptance; external FISS/DDE workflow may remain distinct |
| Clearinghouse switching | Base tenant config and safety gates exist; response drain/reconciliation lifecycle needs explicit product/engineering follow-up | Yes for state machine and queued/ambiguous attempts | Vendor-specific drain behavior unverified | Vendor revocation/retention, payer ERA transition dates, BAA and operator reconciliation evidence |

“Can engineer now” is not production permission. Production activation remains per tenant and capability and requires active verified configuration, applicable agreements/BAA, provider/payer enrollment, routing verification, authorization, response reconciliation and required MAC evidence. B5 commercial billing does not block unrelated engineering.

## Remaining issues and proposed roadmap

Repository/GitHub review on 2026-11-18 found no separate open Stedi OAuth, provider/enrollment, 277CA/835, HETS or credential-lifecycle implementation issue. Existing work is distributed across the transport and tenant-clearinghouse implementation and the following records:

| Existing record | Current scope/status | Remaining action |
|---|---|---|
| [#727](https://github.com/Engrace-Hospice/chartwarden/issues/727) | Open vendor answers + authorized synthetic contract evidence; L2 implementation is published in draft PR #1057 | Keep open. Preserve original acceptance criteria unless maintainer explicitly narrows them. |
| [#705](https://github.com/Engrace-Hospice/chartwarden/issues/705) | Closed architecture decision for one transport per billing lane; ADR-0053 records tenant-choice and lane consequences | Completed decision; Stedi-specific qualification remains separate. |
| [#749](https://github.com/Engrace-Hospice/chartwarden/issues/749) | Durable per-provider acknowledgement cursor work is merged; Stedi-specific response pull/attribution is not thereby qualified | Use its cursor/replay foundation for a separate Stedi receive qualification slice. |
| [#714](https://github.com/Engrace-Hospice/chartwarden/issues/714) | Closed credential-failure safety work: stable refusal, alerting, no retry storm, and secret/payload-safe behavior | Completed foundation; does not establish account lifecycle, credential rotation, or Stedi response qualification. |
| [#820](https://github.com/Engrace-Hospice/chartwarden/issues/820) | M41 recovery/fetchClaimStatus follow-up; not a Stedi account onboarding issue | Keep scoped to M41 quarantined-ack replay and shared status work. |
| [#837](https://github.com/Engrace-Hospice/chartwarden/pull/837) and [#839](https://github.com/Engrace-Hospice/chartwarden/pull/839) | M23 stored ISA13/Stedi JSON routing and tenant-owned clearinghouse resolver integration are merged | Current foundations; no duplicate issue needed for those completed slices. |
| ADR-0053 | Accepted tenant choice, per-tenant credentials/configuration, verification, BAA and activation lifecycle | Add a dedicated Stedi OAuth design/implementation issue when vendor approval and required integration documentation are available; do not expand #727 into OAuth implementation. |

Recommended order, no new issues created here:

1. **Highest-priority engineering follow-up independent of vendor answers:** complete response identity and mismatch-quarantine contract around the existing M23/M25 receive workers, using synthetic fixtures and immutable tenant/account/provider/submission provenance. Vendor-specific response identifiers remain an adapter input; unknown or conflicting attribution must hold, never cross-post. This strengthens safety before adding more Stedi receive paths.
2. Implement payer directory discovery and provider/enrollment status synchronization with typed, fail-closed results and local fixtures; keep authorization and payer/MAC approval explicit.
3. After Stedi supplies OAuth approval/integration guide, build OAuth authorization, token lifecycle and Integrated Account binding behind a non-production/fail-closed provider.
4. Qualify Stedi 999/277CA events and polling, then 835 retrieval/Test Payer enrollment, each as separate capability evidence; validate response attribution and replay before activation.
5. Qualify hospice routes and notice business rules per MAC; evaluate HETS separately; handle adjustments/voids and switching/reconciliation as separate workflows.

Create new follow-up issues only after checking for duplicates and agreeing the owner/acceptance evidence. Broader OAuth, 835/277CA receive path, MAC certification, HETS and financial reconciliation are not #727 closure criteria.

## Abbreviated vendor follow-up questions

The full historical questionnaire remains at [`STEDI_QUESTIONS_20261008.md`](./STEDI_QUESTIONS_20261008.md). A concise follow-up should request written, account-specific answers for:

1. **Q14 / contract qualification:** confirm this Production account is authorized for the described Test-key synthetic 837I workflow, required settings/provisioning, and whether successful JSON/raw-X12 submissions return durable receipt IDs and synthetic 277CA; specify what must be enabled for later test response retrieval.
2. **Q32 / OAuth and attribution:** confirm ChartWarden may register/use a partner OAuth app and Integrated Accounts; supported one-organization/multiple-provider model; stable account/provider identifiers in submissions, callbacks, polling and reports; scopes, revocation/uninstall effects and pending-response access. State how customer Test-mode qualification differs from OAuth account calls.
3. **Q16 / Medicare hospice:** for each applicable HH+H MAC, provide payer IDs and separate 837I, NOE, NOTR, ERA and 276/277 support; required NPI/TIN/PTAN/CCN/forms/transaction enrollments and provider/MAC actions; explain Oregon routing and payer-record lookup. Confirm whether notice formats differ by raw-X12 versus JSON.
4. **Q17/Q28:** distinguish rejected pre-adjudication correction, in-process claim, paid adjustment, cancellation and external FISS/DDE correction; specify whether 8x7/8x8 are accepted by the API and for which MACs.
5. **Q33 / lifecycle and commercial terms:** identify BAA signer(s), ChartWarden app-provider agreement and PHI scope; confirm account billing ownership, consolidated-billing availability, credential revocation and pending transaction/ERA recovery after uninstall or switch.

No message has been sent. Do not mark any answer `VENDOR_WRITTEN_CONFIRMED` until its written source and date are retained.

## Official sources reviewed 2026-11-18

| Source | What it establishes | Limitation |
|---|---|---|
| [Stedi Test mode](https://www.stedi.com/docs/healthcare/test-mode) and [Test claim workflows](https://www.stedi.com/docs/healthcare/test-claims-workflow) | Free Sandbox cannot submit test claims; Production accounts can use Test-mode keys; Test mode is not routed to payers; test claims can yield synthetic 277CA; Test Payer ERA flow requires provider enrollment created outside Test mode and subsequent Test-key use. | Public product behavior, not ChartWarden account authorization or observed success. |
| [Stedi OAuth apps](https://www.stedi.com/docs/healthcare/oauth-apps), [OAuth setup](https://www.stedi.com/docs/healthcare/oauth-apps-setup), [Integrated Account overview](https://www.stedi.com/docs/healthcare/integrated-account-overview), [legacy setup](https://www.stedi.com/docs/healthcare/integrated-account-setup-legacy) | OAuth guide describes OAuth 2.1 authorization code + PKCE, state validation, account ID in response, token/refresh behavior and install/uninstall events; Integrated Accounts document account-level connection/isolation. | Full integration guide requires contact with Stedi; public docs do not prove ChartWarden approval or exact provider/response scoping. Do not treat a public guide as OAuth approval. |
| [Stedi payer search](https://www.stedi.com/docs/healthcare/api-reference/get-search-payers), [enrollment](https://www.stedi.com/docs/healthcare/credentialing-and-enrollment), [retrieve enrollment](https://www.stedi.com/docs/healthcare/api-reference/get-enrollment) | Payer directory can be queried by identifier/transaction; enrollment is provider/payer/transaction work and exposes lifecycle statuses. | Directory metadata and a `LIVE` status do not establish hospice/MAC acceptance, a specific effective date, or account-specific authorization. |
| [Stedi institutional claims](https://www.stedi.com/docs/healthcare/api-reference/post-healthcare-institutional-claims), [receive responses](https://www.stedi.com/docs/healthcare/receive-claim-responses) | JSON 837I and reference-based retrieval via events or polling are public API patterns. | No successful Stedi response retrieval or tenant-attribution run exists in this repository. |
| [Stedi resubmission guidance](https://www.stedi.com/docs/healthcare/resubmit-cancel-claims) and [CGS HH+H Adjustments/Cancels](https://www.cgsmedicare.com/hhh/education/materials/Adjustments_Cancels.html) | Stedi general Medicare resubmission guidance and CGS's MAC-specific FISS/DDE 817/827 and 818/828 correction workflows. | Different workflow contexts; neither proves Stedi API support for every hospice paid-claim action. |
| [Stedi billing/pricing](https://www.stedi.com/docs/healthcare/billing) | Public page describes pay-as-you-go and custom plans; custom includes consolidated billing for Integrated Accounts. | Does not establish tenant-specific contract terms, availability, or the proposed direct-pay arrangement. |
| [CMS HETS](https://www.cms.gov/data-research/cms-information-technology/hipaa-eligibility-transaction-system), [CMS MAC overview](https://www.cms.gov/medicare/coding-billing/medicare-administrative-contractors-macs/who-are-macs), [CMS HH+H jurisdiction map](https://www.cms.gov/medicare/medicare-contracting/medicare-administrative-contractors/downloads/homehealthhospicemacjurisdictionmap.pdf) | HETS is the Medicare FFS eligibility system; CMS distinguishes HH+H jurisdiction assignment; current map places Oregon in NGS jurisdiction D. | These sources do not confirm Stedi payer identifiers, provider enrollment status, or a specific claim's routing. |

The Stedi Medicare-enrollment blog URL requested in the audit could not be inspected during this review and is not relied on here. Public page details can change; revisit before a later qualification or production decision.
