# M23 — Medicare Hospice Findings

## Existing capability

M23 has a server-authoritative assembly and validation pipeline rather than a generic form-to-837 shortcut. Assembly requires Medicare FFS coverage for the full range, blocks a Medicare Advantage row as primary, resolves hospice periods and derives TOB/lines from admission, claim continuity and billing facts ([claim-assembly.ts](../../../apps/backend/src/modules/23-billing-medicare/services/claim-assembly.ts#L202)). Validation refreshes claim snapshots and occurrence spans from current data, then persists a run ([claim-validation-service.ts](../../../apps/backend/src/modules/23-billing-medicare/services/claim-validation-service.ts#L191)). The transport loader gathers current payer/provider/receiver context, uses audited MBI unlock, and reports all missing required values rather than inventing them ([claim-837i-loader.ts](../../../apps/backend/src/modules/23-billing-medicare/services/claim-837i-loader.ts#L1)).

The API exposes claim assembly, draft edit/delete, validate, submit, TOB-817 replacement and TOB-818 void routes with permission/ABAC, step-up and `If-Match` protections ([claims.routes.ts](../../../apps/backend/src/modules/23-billing-medicare/routes/claims.routes.ts#L182)). The worker repeats eligibility preflight before the upload, records durable attempt outcome and changes state only after acceptance by the configured upload port ([m23-jobs.ts](../../../apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts#L916)).

## Findings

### M23-1 — Claim.MD payer ID needs per-route proof (P1, defective/configuration-sensitive)

`buildClearinghouseContextPort` sets `payerId` to the global `CLEARINGHOUSE_PAYER_ID` override or falls back to `macJurisdiction` ([clearinghouse-context.ts](../../../apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-context.ts#L12), lines 40–78). That fallback is an internal MAC jurisdiction, not evidence that it is a Claim.MD payer identifier. A single global override also cannot represent distinct payer routes if provider entities use different MAC jurisdictions/routes. The current 837I loader uses the context payer for receiver/routing; the Claim.MD adapter checks outbound identity consistency but does not establish that an M23 jurisdiction string maps to the correct vendor payer ID.

**BIL-2 correction:** add a typed, provider-entity/MAC-jurisdiction/usage-aware payer-route resolver backed by the existing approved payer configuration; refuse Claim.MD submission when unresolved. Do not accept a client-supplied payer ID or infer vendor IDs. Add tests for two provider entities and distinct routes, missing route, account environment mismatch, and unchanged legacy-MAC behavior.

### M23-2 — Hospice notices are not generic claims and are not certified through Claim.MD (P1 activation blocker, not a claim-preparation defect)

NOE, NOTR and transfer each have separate route/service/rendering and relationship logic (`routes/noe.routes.ts`, `notr.routes.ts`, `transfer-notice.routes.ts`; `jobs/m23-jobs.ts` `runNoeSubmit`, `runNotrSubmit`, `runTransferNoticeSubmitJob`). BIL-1.5A.2 added typed immutable notice evidence and the external upload remains disabled pending Claim.MD support confirmation ([NOTICE_TRANSPORT_MATRIX.md](../BIL-1.5A.2/NOTICE_TRANSPORT_MATRIX.md#L1)). Do not make BIL-2 claim flows automatically submit notices or treat claim 999/277CA as notice acceptance.

CMS Pub. 100-04, Ch. 11, Rev. 13190 (2025-04-24), distinguishes NOE, NOTR, transfer and institutional hospice claims. The NOE must be submitted and accepted within five calendar days; late NOE days have separate noncovered/OSC 77 treatment. NOTR is not for transfers and must reference an established election. See [CMS Medicare Claims Processing Manual, Ch. 11 §§20.1.1–20.1.3 and 30.3](https://www.cms.gov/Regulations-and-Guidance/Guidance/Manuals/Downloads/clm104c11.pdf). These are separate workflow contracts, not a generic 837 assumption.

### M23-3 — Correction workflow exists; verify exact payload/source version on changed facts (P2)

The replacement endpoint explicitly creates a new 817 draft from original lines and void creates an 818 draft; both are versioned and step-up gated ([claims.routes.ts](../../../apps/backend/src/modules/23-billing-medicare/routes/claims.routes.ts#L328)). BIL-2.1 should verify that edited/corrected claim facts rerun all current rule and source snapshot derivations before a new send, and that history links original→replacement→void without changing original attempts. Do not redesign the state machine absent a failing case.

### M23-4 — EDI identity and historical evidence are already substantial (reuse)

BIL-1.2.2A/B records immutable submission evidence and resolver identity for Claim.MD. The send path reserves evidence before the HTTP call and appends vendor receipt identifiers ([clearinghouse-submission.ts](../../../apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-submission.ts#L152)). Keep it intact; BIL-2 should only add route-resolution inputs or claim-preparation fields where verified necessary.

## Current regulatory item checked

As of 2026-11-07, CMS's Hospice news page says the mandatory written election statement addendum applies to every election starting 2026-10-01, with enforcement discretion through 2026-12-31; M23 source has an `election_addendum_signed` validation rule backed by an M6 seam (`claim-assembly-facts.ts` around line 78 and `boot-assembly.ts` around lines 180–184). This is not automatically a missing claim feature. Confirm that the M6 seam is bound in the target environment and that UX presents its outcome. CMS also announced FY2027 face-to-face telehealth claim coding beginning 2027-01-01; schedule a dated rule review before that effective date rather than hard-coding this audit's text. Source: [CMS Hospice News, 2026-10-29 page state](https://www.cms.gov/medicare/enrollment-renewal/providers-suppliers/information-centers/hospices/news-announcements).

## Recommended implementation boundary

First vertical slice should stabilize M23 Claim Preparation & Validation: read-only preview built from the exact final 837I renderer, clear field-to-source remediation, explicit payer route readiness, fresh rule evaluation and immutable attempt history. Preserve independent notice workflows and their off switch.
