# Episode Alert architecture and evidence

**Reviewed:** 2026-11-18

**Scope:** EPA-755-L3 evidence consolidation and architecture planning. This is not vendor qualification, an activation approval, or a ratification of ADR-0103.

## Evidence labels

| Label | Meaning |
|---|---|
| `PUBLICLY_ADVERTISED` | A product page describes a capability; this is not an API contract. |
| `PUBLICLY_DOCUMENTED` | An official public technical or government source establishes the stated fact. |
| `MAINTAINER_REPORTED` | Information reported by the maintainer; no account-specific written reply is filed here. |
| `VENDOR_WRITTEN_CONFIRMED` | An account-specific written confirmation from Episode Alert. None is recorded for the items below. |
| `ARCHITECTURE_DECIDED` | A ChartWarden decision already recorded in an ADR. |
| `LOCAL_TEST_VERIFIED` | Local synthetic or fake-client behavior only. |
| `VENDOR_TEST_VERIFIED` | An authorized, recorded Episode Alert test observation. None is recorded. |
| `MAC_VERIFIED` | Evidence for the applicable hospice MAC/provider enrollment and workflow. None is recorded for ChartWarden customers. |
| `AWAITING_VENDOR` / `AWAITING_LEGAL` | External vendor or contractual decision still needed. |

Evidence can have several labels at once. A public product claim or local test never becomes account-specific written confirmation or qualification by implication.

## Current disposition

- `ARCHITECTURE_DECIDED`: ADR-0052 keeps manual DDE as the baseline. ADR-0053 leaves each tenant in control of its clearinghouse selection. ADR-0103 is **Proposed**, not ratified; its D2 platform-held credential is a proposed inactive configuration, not evidence that a shared credential is authorized.
- `LOCAL_TEST_VERIFIED`: the generic `DdeAccessProvider`, registry, in-memory reference, M23 queue/send/sync and daily-change processing scaffolding exist. The Episode Alert DDE adapter remains a fail-closed skeleton; `EA_DDE_WIRE.verified` is false and its mappings are unverified.
- `LOCAL_TEST_VERIFIED`: Episode Alert eligibility has local request/parser plumbing and synthetic fixtures. The XML field/root assumptions remain unverified. The `ELIGIBILITY_VENDOR` package registry has no backend consumer; M23 eligibility is still bound through `M23_HETS_TRANSPORT`.
- Claim status and remittance methods remain `CH_NOT_WIRED`. No Episode Alert API endpoint, authentication scheme, message schema, test environment, or account-specific authorization has been recorded.
- No actual vendor test, applicable MAC qualification, provider enrollment, signed BAA, or ChartWarden vendor authorization is evidenced here. Episode Alert remains unbound; manual DDE remains available.
- `MAINTAINER_REPORTED`: the product priority is hospice NOE/NOTR submission, tracking, correction and reconciliation through Episode Alert if its documented contract supports a safe route. This does not establish vendor support or a selected implementation route.

### Historical local validation evidence

The published L1 record reports 120 focused Episode Alert/DDE/conformance tests passed; vendor contract execution remained skipped. The L2 record reports 7 focused DDE backend/frontend test files with 150 tests passed, plus scoped Biome, typed-client, UI-doc, PHI-scan and diff checks. These are historical local results from PR #1059, not tests rerun for this documentation lot and not vendor or MAC qualification.

## Official public source review

Pages below were reviewed on **2026-11-18**. Product-site claims are recorded as advertised capabilities, not technical contracts. A public web page cannot prove ChartWarden account eligibility, provider-specific authorization, test isolation, or production readiness.

| Source | What it establishes | What it does not establish |
|---|---|---|
| [Episode Alert Medicare Eligibility API](https://episodealert.com/medicare-eligibility-api.aspx) | `PUBLICLY_ADVERTISED`: REST POST API; X12 responses translated to XML; eligibility, daily claim status, claim submission/remittance retrieval, PECOS verification and NPI lookup are advertised; guide and sample calls are described as available to customers. | No exact endpoint, auth, request/response schema, pagination, error contract, account approval, sandbox, or ChartWarden authorization. Advertised claim submission does not establish supported hospice/DDE operations. |
| [Episode Alert Medicare eligibility sample report](https://episodealert.com/medicare-eligibility.aspx) | `PUBLICLY_ADVERTISED`: the displayed eligibility report advertises Medicare and hospice-related fields, including hospice periods and provider/revocation details. | A browser/report sample does not establish XML API element names, completeness, source, freshness, or the schema used by the adapter. |
| [Episode Alert SmartDDE](https://episodealert.com/smart-dde.aspx) | `PUBLICLY_ADVERTISED`: hosted SmartDDE monitoring, daily status-change reporting and alerts. | No programmatic report endpoint, cursor, retention, stable event ID, or operation attribution contract. |
| [Episode Alert DDE Connection](https://episodealert.com/dde-connection.aspx) | `PUBLICLY_ADVERTISED`: hosted DDE access/browser workflow. | No supported API write operation, no authorization model for ChartWarden, and no evidence that browser functionality is available through an API. |
| [Episode Alert claim submission](https://episodealert.com/medicare-claim-submission.aspx) | `PUBLICLY_ADVERTISED`: claim/EDI services and remittance-related workflow. | No developer API contract, supported hospice transaction mapping, or live routing qualification. |
| [Episode Alert NSV page](https://episodealert.com/CMS-network-service-vendor-approved.aspx) | `PUBLICLY_ADVERTISED`: Episode Alert claims CMS Network Service Vendor approval and nationwide service. | Does not approve ChartWarden, prove a particular API is approved for each transaction, or satisfy an individual provider's enrollment/authorization. |
| [Episode Alert Business Associate Agreement page](https://episodealert.com/businessassociate.aspx) | `PUBLICLY_ADVERTISED`: a public BAA template and a description of the parties. | Does not show that ChartWarden has executed, accepted, or received legal approval for that BAA, or resolve all direct-vendor/tenant contractual responsibilities. |
| [Episode Alert pricing](https://episodealert.com/pricing.aspx) | `PUBLICLY_ADVERTISED`: public eligibility pricing and trial marketing. | Does not establish partner pricing, DDE/API usage limits, a sandbox, or the commercial arrangement for this integration. |
| [Episode Alert website terms](https://episodealert.com/terms.aspx) | Public website terms were accessible. | Not an account-specific partner, API, BAA, or customer contract review. |
| [CMS HETS EDI enrollment](https://www.cms.gov/data-research/cms-information-technology/hipaa-eligibility-transaction-system-hets/hets-edi-how-enroll) and [CMS HETS enrollment validation notice](https://www.cms.gov/data-research/cms-information-technology/hipaa-eligibility-transaction-system/mcare-notifications/medicare-hets-270-271-hets-edi-enrollment-validation-5-11-26) | `PUBLICLY_DOCUMENTED`: beginning 2026-05-11, each NPI sent by a third-party HETS submitter must have the required current valid enrollment relationship with that submitter; HETS rejects requests without it. Enrollment involves provider NPI/PTAN and the vendor relationship. | Does not establish Episode Alert's ChartWarden account setup, a provider's actual enrollment state, or DDE/claim/ERA authorization. HETS enrollment is separate from Medicare provider enrollment and DDE access. |
| [CMS MAC geography: current Medicare coverage/local determination page](https://www.cms.gov/medicare/coverage/determination-process/local), [CMS J6 page](https://www.cms.gov/medicare/medicare-contracting/medicare-administrative-contractors/who-are-the-macs-a-b-mac-jurisdiction-6-j6), and [CMS current MCD contractor record](https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdid=33393&ver=9) | `PUBLICLY_DOCUMENTED`: Oregon is within HH+H jurisdiction J6; CMS current materials identify Wellpoint Federal for HH+H J6 effective 2026-04-01, formerly National Government Services (NGS). CMS distinguishes A/B MAC contracts from HH+H MAC work. | Jurisdiction does not prove a specific hospice's payer record, NSV transaction enrollment, DDE authorization, or current vendor route. Check the provider's actual enrollment and payer directory at onboarding. |
| [NGS historical HH+H welcome letter, J6](https://www.ngsmedicare.com/documents/20124/121662/2202_0724_HHH_welcome_letter%20updated%2010-17-2_508.pdf/) | `PUBLICLY_DOCUMENTED`, historical: NGS material identifies Oregon within HH+H J6. | It predates CMS's 2026-04-01 Wellpoint Federal naming in current HH+H records; it is not the current provider-specific routing authority. Do not hardcode historical `NGS`, `MDCKC`, or `12M41` from unrelated/older Oregon Part A references as the hospice route. |
| [CGS FISS index](https://www.cgsmedicare.com/fiss/index.html) | Public FISS resources for CGS jurisdictions. | CGS is not Oregon's current HH+H J6 contractor and its pages do not qualify Oregon routing. The linked [Palmetto JH notice](https://palmettogba.com/jmhhh/did/7glsdh2360) returned HTTP 403 on review and is not treated as inspected evidence. |

The Episode Alert public API and product pages were accessible. The linked vendor guide, exact API specification, account-specific written replies, and applicable provider/MAC enrollment records were not available in the repository. No public source reviewed here supplies the missing wire contract.

## Integration boundaries and recommended direction

Keep these evidence and execution paths separate:

| Concern | Existing boundary | Evidence meaning |
|---|---|---|
| Tenant clearinghouse claim submission | `ClearinghouseTransport`, tenant-selected by ADR-0053 (`stedi`, `claimmd`, or `outside`) | Submission/acknowledgment identity remains with the selected clearinghouse. Episode Alert must not become a second active submission authority for the same claim by accident. |
| Medicare HETS eligibility | M23 `M23_HETS_TRANSPORT` and the existing HETS workflow | HETS 270/271 is subject to per-NPI enrollment with the actual third-party submitter. It is distinct from DDE. |
| Episode Alert eligibility | Eligibility-only registry seam; no backend consumer | Potential complementary source or future adapter behind the existing M23 eligibility abstraction; must preserve source/provenance and hospice-period data. Do not create a parallel eligibility workflow or infer that partial Part A means complete hospice eligibility. |
| DDE writes and reads | `DdeAccessProvider` / ADR-0103, separate from clearinghouse transport | Programmatic operation must be documented, attributable to the individual, and supported per operation. Hosted SmartDDE/DDE UI is not evidence of an API. |
| FISS status and change reporting | M23 DDE queue/provider status and daily-change plumbing | FISS/DDE status is distinct from 999/277CA clearinghouse acknowledgments and payer 276/277 claim status. |
| ERA/remittance | M25 ingest, source resolution, duplicate hold and staged delivery | A future Episode Alert source must carry immutable vendor/account/provider identity and source digest through M25. If the same ERA is received from multiple authorized sources, stage/post it once; keep exact and possible duplicates held per existing controls. |

**Maintainer-reported product direction:** Episode Alert is primarily intended for hospice NOE/NOTR workflows, not to replace the tenant's ordinary claim-submission clearinghouse. This is product prioritization, not vendor confirmation or selection of a wire contract. Keep each tenant's Stedi, Claim.MD, or outside claim-submission choice under ADR-0053. Do not bind Episode Alert to `CLEARINGHOUSE_VENDOR` by default or create a second submission path for the same notice.

The exact NOE/NOTR route remains unknown. Select the existing port only after written vendor evidence establishes the mechanism and its authorization. A future notice-routing policy must define one authoritative path per notice and attempt. An uncertain or already accepted notice must not be sent through another provider merely because another path is available.

| Priority | Capability | Intended role |
|---|---|---|
| Primary | NOE / NOTR, submission receipt, MAC acceptance/rejection evidence, status, filing deadline, correction and reconciliation | Intended Episode Alert use, contingent on a documented supported route and authorized qualification. |
| Complementary | FISS/DDE status and daily change reporting | Operational reconciliation signals; distinct from clearinghouse acknowledgments and payer claim-status responses. |
| Secondary | Eligibility/hospice history, general claim status, adjustments/cancellations, ERA/remittances, ordinary claim submission | Still in scope of the existing issue/adapter questions where applicable. Secondary does not mean unsupported or cancelled. These do not replace NOE/NOTR priority. |

Potential notice routes remain conditional: documented institutional EDI notice submission; documented DDE API operation attributed to an individually authorized operator; hosted DDE with manual submission and recorded ChartWarden evidence; or read-only reporting/reconciliation if no supported write API exists. Manual browser use does not authorize automation. If only hosted/manual support exists, preserve the current manual DDE workflow and ask the maintainer to decide whether to revise the integration scope.

For eligibility specifically, compare an adapter behind the current M23 HETS abstraction, a separately selected Medicare eligibility source, and a complementary source for verified supplemental hospice fields. The smallest coherent future option is an adapter within the existing M23 eligibility workflow if the vendor is an authorized HETS submitter and per-NPI CMS enrollment is verified; a separate source requires a canonical result/provenance model. Do not infer complete hospice eligibility from partial Part A data.

| Eligibility integration option | Trade-off | Current recommendation |
|---|---|---|
| Adapter behind the existing M23 HETS/eligibility abstraction | Reuses the single eligibility workflow and existing MBI/audit boundary; can preserve source identity and CMS per-NPI enrollment checks. Requires a provider-selection/resolution decision and complete response mapping. | Smallest coherent option if Episode Alert is authorized as an HETS submitter and the product elects to use it for those checks. |
| Separately selected Medicare eligibility provider | Keeps the current HETS binding distinct, but adds another selection/configuration surface and risks divergent result handling or duplicated checks. | Use only if the product needs two explicitly selectable eligibility sources and can define one canonical result/provenance model. The package registry alone is not that runtime workflow. |
| Complementary source for supplemental hospice data | Could supplement verified HETS output if the API returns additional hospice periods; partial data can be missing or stale. | Do not treat it as a coverage decision. Add only documented fields with independent source/time provenance; unknown or absent hospice data remains unknown. |

## Account and isolation models

| Model | Account/credential ownership | Consequences and evidence needed |
|---|---|---|
| A — tenant-owned account | Each hospice owns its Episode Alert account and agreement; ChartWarden binds a tenant-authorized account. | Best fit for ADR-0053's tenant-owned clearinghouse relationship and customer revocation. Vendor must confirm partner authorization/API access, tenant/provider identity, billing and the OAuth/API credential lifecycle. |
| B — partner with isolated subaccounts | ChartWarden has a partner relationship, but each hospice has a vendor-recognized isolated account/subaccount. | Could support onboarding centrally while retaining tenant/provider attribution. Requires written proof of isolation, stable external account identity, per-tenant authorization/revocation, response routing, billing and BAA coverage. |
| C — shared platform credential | One platform credential accesses multiple providers/tenants. | Do not use unless the vendor contract explicitly permits it and independently verifiable tenant, provider and operator authorization/response attribution are enforced. Billing NPI alone is insufficient evidence of isolation. Higher cross-tenant blast radius. |

**Recommendation:** prefer A or a properly isolated B. Keep C only as an unapproved possibility pending vendor and legal evidence. ADR-0103 D2 currently proposes platform-held credentials but remains Proposed; do not silently turn that proposal into a final architecture or activate it. No credential migration/storage change is part of this lot.

Assess account ownership separately for a DDE vendor account versus a tenant's clearinghouse relationship. Before choosing, resolve account identity, provider enrollment, operator authorization, revocation, historical reconciliation, BAA coverage and direct/partner billing.

## Mandatory scoped capability evaluation before activation

Current `ddeProviderCapability()` is a **platform-level queue snapshot**. It reports provider mode and operation types. `QualifiedDdeOperations` is code-wired qualification, not a tenant/provider/operator authorization record. Today `apps/backend/src/index.ts` calls `bindDdeProvider(process.env, {})`, does not inject qualified operations, and keeps the Episode Alert factory unregistered. Therefore there is no real Episode Alert action path today. However, a future composition-root injection of `vendor_qualified` would be too broad on its own.

Before a real operation can be offered or executed, a future evaluator must establish all applicable facts for the current request:

1. Platform/vendor wire and operation qualification.
2. Provider support for this exact operation (e.g. NOE does not imply adjustment support).
3. Tenant/account binding, enablement and authorization.
4. Provider-entity authorization under that account and applicable Medicare/MAC enrollment.
5. Acting-operator permission and, where required, that operator's individually attributable DDE identity/enrollment.
6. ChartWarden permission, tenant/provider scope, assignment/ownership, item state and expected version.
7. Required step-up authentication and absence of an unresolved in-doubt marker.
8. Runtime revalidation when the mutation occurs; the UI's capability snapshot is staleable and never grants authority.

Unknown, expired, revoked or conflicting identity/enrollment must fail closed. Do not use a global qualification boolean, billing NPI alone, or a prior UI snapshot as authorization.

| Case | Required result |
|---|---|
| Tenant A enrolled, tenant B not | A may be evaluated under its binding; B sees no executable provider operation and receives a server refusal. |
| Two provider entities in one tenant; only one authorized | Scope operations to that entity; never infer from tenant-level enablement. |
| Operator authorized for A, not B | Deny B for that operator, even if the provider account supports both. |
| Operator access revoked after UI load | Mutation-time authorization rejects; stale capability is not reusable. |
| Eligibility supported, DDE writes not | Expose only the eligible capability, through the proper M23 eligibility path. |
| NOE supported, adjustment unsupported | NOE may be separately qualified; adjustment remains unavailable. |
| Account identity unknown or vendor authorization expired | Fail closed; no request and no durable send marker. |
| Item in doubt | Prevent another electronic submission; preserve manual reconciliation and provenance. |
| Background worker fetches outcomes | Bind to the submitted account/provider/operator provenance and validated worker authority; never substitute an arbitrary operator. |
| Item belongs to disconnected account | Preserve source/account identity; do not silently rebind or resubmit. Recovery requires documented vendor access and explicit reconciliation. |

This evaluator is a pre-activation dependency for #759 and any provider-assisted actions. It is not implemented in this documentation lot. No speculative enrollment table or external identity schema is proposed.

## DDE support decision matrix

The vendor must answer each operation independently. Publicly advertised hosted DDE does not establish an API write operation.

| Operation | Current ChartWarden plumbing | Vendor/MAC evidence required before implementation or activation |
|---|---|---|
| NOE / NOTR | Generic DDE operation types and manual queue; EA wire unverified | Written API yes/no, transaction format, required hospice fields, provider/MAC enrollment, individual operator attribution, test semantics and outcome retrieval. |
| Claim entry | Generic operation kind/manual workflow; no verified EA DDE API | Same plus exact transaction boundaries and whether it is distinct from clearinghouse claim submission. |
| RTP correction | Manual queue and correction workflow | API support, who may key, returned-to-provider semantics, idempotency and reconciliation. |
| Adjustment / cancellation | Existing manual/fail-closed business handling | Separate API support and MAC rules; do not conflate with ordinary rejected-claim resubmission. |
| ADR response | Generic DDE operation kind | API support, document/evidence handling, individual authorization and outcome semantics. |
| Claim status | Clearinghouse transport methods remain `CH_NOT_WIRED`; DDE provider skeleton unverified | Identify whether result is payer 276/277, FISS/DDE status, or daily change report; provide contract and source identity. |
| Daily change report | Cursor persistence and M23 ingest plumbing exist (#793) | Exact API or supported export, cursor/paging, event identity, retention, attribution, duplicates and replay rules. |
| Other operation | No assumed support | Written explicit operation-level support and qualification before adding a mapping. |

If writes exist with compliant individual attribution, #759 can continue after docs and account authorization. If writes exist without individual attribution, keep writes disabled and escalate ADR-0103 D4; do not weaken it. If no API exists, retain manual DDE. If only read/report operations exist, develop qualified read/reconciliation work independently.

## Readiness and blockers

| Capability | Current implementation / runtime | Evidence | Engineering can proceed | Blocks vendor implementation | Blocks production activation | Issues |
|---|---|---|---|---|---|---|
| Eligibility wire | Local adapter/parser; no backend consumer; M23 HETS remains live abstraction | `LOCAL_TEST_VERIFIED`; mappings unverified | Contract-neutral M23 source/provenance design and local fixtures | Guide, endpoint/auth/schema, hospice field definitions, API account access | Per-NPI HETS relationship, vendor/provider authorization, agreement/security review, vendor and provider qualification | #758, #762 |
| Hospice history mapping | Adapter currently interprets only guessed Part A dates; no verified hospice-period mapping | Local fixture evidence only | Define safe unknown/partial display and provenance | Written XML/API schema and field semantics | Vendor test and applicable provider/MAC qualification | #758 |
| Claim status | Methods return `CH_NOT_WIRED`; no consumer | Publicly advertised only | Source model distinguishing payer, clearinghouse and FISS status | Request/response/status vocabulary and identifiers | Vendor authorization, operational qualification | #758, #793 |
| Remittance retrieval | Methods `CH_NOT_WIRED`; M25 has established receive/duplicate controls for existing source paths | Local M25 evidence; no EA | Define immutable source identity and adapter boundary | Format, query, pagination, retention, payee/account attribution | Enrollment/ERA destination rules, duplicate-source reconciliation, contractual approval, qualification | #758, M25 follow-up if required |
| DDE writes | Generic port + Episode Alert fail-closed skeleton; not bound | Local conformance/reference tests only | Scope-aware evaluator and local authorization tests | Per-operation API and outcome semantics, individual DDE identity, idempotency | Account/provider/operator authorization, MAC support, test isolation, vendor and MAC qualification | #759, #762 |
| Daily changes | M23 cursor/cron/quarantine plumbing exists but EA wire not mapped | Local synthetic tests | Contract-independent retry/reconciliation safeguards | Endpoint/export schema, pagination, event identity and semantics | Vendor access and qualified account/operator attribution | #793, #759 |
| Operator identity | Context carries ChartWarden membership ID; vendor identity mapping unknown | Architecture decision in ADR-0103 D4; no vendor proof | Domain model/protocol design after facts | Whether vendor can act/read as each individual and how identity is provisioned/revoked | Individually attributable authorization and MAC acceptance | #759, #762 |
| Scoped capability | L2 server snapshot is global; root wires no qualified operations | Local tests; future activation gap | Design/evaluate scoped capability and mutation-time rechecks | Account/provider/operator identity model | Must be implemented and security-tested before any real operation | #759, #763 |
| Account ownership | ADR-0103 D2 proposes platform-held; ADR-0053 tenant clearinghouse is separate | ADR-0103 Proposed; vendor/legal unresolved | Compare A/B/C and define stable internal interface | Partner/customer account model, identity and billing | Contract, BAA, tenant/provider isolation and revocation readiness | #756, #762 |
| Sandbox and vendor qualification | No verified sandbox; DDE contract suite unavailable; no requests executed | No `VENDOR_TEST_VERIFIED` | Prepare deterministic local conformance and reports | Written safe test procedures and approved account/key | Human authorization, isolated vendor test, approved synthetic data, evidence capture | #758, #759, #762, #763 |
| MAC/provider enrollment | No provider-specific enrollment evidence in repo | CMS public HETS rules and jurisdiction only | Build enrollment-status representation after official rules are collected | Vendor-specific forms/identity and actual provider requirements | Provider's HETS vendor relationship, HH+H/NSV/DDE transaction approvals | #762 |
| Agreement/security/commercial | Public BAA template/pricing page only | `PUBLICLY_ADVERTISED`; `AWAITING_LEGAL` | Synthetic engineering may continue | Partner API terms/data handling details | Executed/reviewed agreement, privacy/security approval, agreed billing and retention | #762 |

Development is not globally blocked. Vendor endpoints, customer PHI exchange, live write actions, and production activation remain separately gated by the dependencies above.

## Issue state reconciliation (reviewed 2026-11-18)

GitHub issue states and comments were checked against the implementation. Closed means the scoped engineering task was merged, not that an Episode Alert service is operational.

| Issue / PR | GitHub state | Current evidence and remaining work |
|---|---|---|
| [#755](https://github.com/Engrace-Hospice/chartwarden/issues/755) | Open | Tracking issue. Historical checklist predates completed port, workflow, UI and safety lots. Keep open for vendor evidence, scoped activation dependencies and final qualification. |
| [#756](https://github.com/Engrace-Hospice/chartwarden/issues/756) | Closed | ADR task delivered as ADR-0103 via #764. Issue title's ADR-0054 is stale/incorrect; ADR-0054 is not the DDE ADR. ADR-0103 remains Proposed. |
| [#757](https://github.com/Engrace-Hospice/chartwarden/issues/757) | Closed | Generic DDE provider port/registry/in-memory reference/conformance merged in [#764](https://github.com/Engrace-Hospice/chartwarden/pull/764). Does not bind a real provider. |
| [#758](https://github.com/Engrace-Hospice/chartwarden/issues/758) | Open | Eligibility skeleton in [#769](https://github.com/Engrace-Hospice/chartwarden/pull/769); separate fail-closed registry in [#812](https://github.com/Engrace-Hospice/chartwarden/pull/812). No backend consumer; status and remits remain unwired. |
| [#759](https://github.com/Engrace-Hospice/chartwarden/issues/759) | Open | DDE skeleton from #793 remains unverified and unbound. Needs per-operation API contract, individual attribution and scoped authorization before wiring. Its older comment's trial-key/environment-gate recipe is superseded by L1; it is not an authorization to run the suite. |
| [#760](https://github.com/Engrace-Hospice/chartwarden/issues/760) | Closed | M23 provider submit/sync state workflow exists; no Episode Alert adapter activation follows from closure. |
| [#761](https://github.com/Engrace-Hospice/chartwarden/issues/761) | Closed | Queue/provider UI delivered; L2 adds accurate capability and provenance presentation. Real provider remains unavailable. |
| [#762](https://github.com/Engrace-Hospice/chartwarden/issues/762) | Open | Human onboarding, vendor responses, account authorization, enrollment, agreements and commercial facts remain. [#791](https://github.com/Engrace-Hospice/chartwarden/pull/791) added docs only; nothing was sent or signed. Its old trial-first checklist is superseded by the current gated runbook. |
| [#763](https://github.com/Engrace-Hospice/chartwarden/issues/763) | Closed | Engineering conformance/docs gates merged by [#839](https://github.com/Engrace-Hospice/chartwarden/pull/839); no actual vendor/MAC qualification. |
| [#793](https://github.com/Engrace-Hospice/chartwarden/issues/793) | Closed | Cursor persistence, MBI seam and adapter skeleton implemented; vendor-specific report mapping remains absent. |
| [#766](https://github.com/Engrace-Hospice/chartwarden/issues/766) | Closed | Manual queue triggers remain useful. Its comment confirms no registered provider and no automatic FISS signal; do not read closure as an EA feed. |

The parent checklist should be corrected during issue finalization: #758/#759/#762 remain open; #763 is closed as engineering scaffolding only; #756 names the wrong ADR; and vendor/MAC qualification is not achieved by the closed child issues.

## Prioritized follow-up questionnaire (prepared, not sent)

The concise messages are in [`EPISODE_ALERT_FOLLOWUP_QUESTIONS_20261118.md`](./EPISODE_ALERT_FOLLOWUP_QUESTIONS_20261118.md). The 2026-10-25 questionnaire is preserved as historical provenance and should not be sent without correcting its Oregon routing reference.

## Next work

1. **Vendor-independent:** prepare a scoped capability authorization design and tests for tenant/account, provider entity, acting operator, operation and mutation-time checks before any real operation is wired. This is a pre-activation dependency, not a reason to block local/manual workflow development.
2. **Human/vendor:** request the API guide, partner/account authorization model, isolated test conditions and operation-by-operation DDE/response contracts; separately have the provider enrollment owner confirm Oregon HH+H J6 requirements with the current MAC and each provider's payer directory/enrollment records.
3. Keep ADR-0103 Proposed until its open decisions and compliant evidence are reviewed. Keep #755, #758, #759 and #762 open. No vendor request, account, enrollment, provider binding or production activation is performed by this lot.
