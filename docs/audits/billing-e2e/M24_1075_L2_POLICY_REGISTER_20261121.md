# M24-1075-L2 policy evidence register

Originally verified 2026-11-21 against public OHA, Oregon Secretary of State and EOCCO material; the
OHA FY2027 hospice memo/schedule and OHA FFS-versus-CCO applicability page were rechecked 2026-11-25.
This register records source facts and qualification limits; it does not certify a customer contract,
payer companion guide, provider enrollment, claim acceptance or production route.

| ID | Policy/source | Scope and effective dates | Verification | M24 consequence |
|---|---|---|---|---|
| OR-HSP-ELIG | [OAR 410-142-0040](https://secure.sos.state.or.us/oard/displayDivisionRules.action?selectedDivision=1729), subsection 0040 | Oregon Medicaid hospice benefit; current rule-history dates are shown by SOS. OHP Plus coverage and CTI are required; Medicare Part A hospice is billed to Medicare. | Current SOS rule page checked 2026-11-21. | Coverage and payer/program responsibility remain separate from clinical eligibility. |
| OR-HSP-CTI | [OAR 410-142-0060](https://secure.sos.state.or.us/oard/displayDivisionRules.action?selectedDivision=1729), subsection 0060 | Certification timing and signed written certification before claims for all benefit periods. | Current SOS rule page checked 2026-11-21. | M6 remains owner of CTI/election/clinical records; M24 does not copy them. |
| OR-HSP-LOC | [OAR 410-142-0260](https://secure.sos.state.or.us/oard/displayDivisionRules.action?selectedDivision=1729), subsection 0260 | Five LOCs: RHC, CHC, in-home respite, inpatient respite and GIP. CHC and in-home respite have day-boundary/minimum-hour rules; inpatient respite has a five-consecutive-day limit and NF-resident restriction. | Current SOS rule page checked 2026-11-21. | M24's M6 seam exposes only four clinical LOCs. In-home respite is not synthesized or mapped to an invented M6 value/revenue code. |
| OR-HSP-RATE | [OAR 410-142-0300](https://secure.sos.state.or.us/oard/displayDivisionRules.action?selectedDivision=1729), subsection 0300; [OHA FY2027 FFS hospice schedule](https://www.oregon.gov/oha/HSD/OHP/Tools/Hospice-Rates100126.pdf); [OHA FY2027 rate memo](https://www.oregon.gov/oha/HSD/OHP/Announcements/Hospice-Rates1026.pdf) | OHA FFS only; schedule applies 2026-10-01 through 2027-09-30. Values vary by CBSA and include RHC day 1-60/day 61+, IRC, GIP, in-home respite and CHC per-hour amounts. OHA notes quality-reporting status can lower provider payment. | OHA memo and schedule rechecked 2026-11-25; current SOS Division 142 page re-opened 2026-11-25. | Rates are not seeded: the preview still lacks authoritative locality, election-day, quality-reporting, clinical quantity and usual-charge evidence. No OHA FFS amount applies to EOCCO by inference. |
| OR-HSP-NF | [OAR 410-142-0290](https://secure.sos.state.or.us/oard/displayDivisionRules.action?selectedDivision=1729), subsection 0290 | Narrow nursing-facility hospice exception; qualifying NF hospice/R&B is billed directly to the Division even for CCO members. | Current SOS rule page checked 2026-11-21. | Does not establish a general hospice CCO carve-out or enable secondary R&B billing. |
| OR-OHA-UB | [OHA Institutional Claim Instructions](https://www.oregon.gov/oha/OHP/Providers/Tools/Institutional-Billing-Instructions.pdf), May 2022, hospice TOB table | OHA operational billing instructions; distinguishes hospital-based 82x from non-hospital 81x cadence. Not an EOCCO companion guide. | Published guide checked 2026-11-21; document itself says May 2022. | Adapter no longer advertises replacement/void TOBs or a production channel. CCO 837I coding remains unqualified. |
| EOCCO-HSP | [EOCCO Provider Manual 2025](https://www.eocco.com/eocco/-/media/eocco/pdfs/provider_manual.pdf), “Hospice care,” p. 35 | Manual states prior hospice notification including CTI, valid for initial six months; beyond that, PA request with care plan and recertification; inpatient hospice requests are reviewed. Manual does not state a hospice-policy effective date. | Public 2025 manual checked 2026-11-21. Current contractual applicability and exact six-month boundary require EOCCO confirmation. | Published rule is documented with current applicability unresolved. No local signature is treated as payer acknowledgment or approval. |
| EOCCO-RATE | [OHA fee schedule policy](https://www.oregon.gov/oha/hsd/ohp/pages/fee-schedule.aspx), “About Oregon Health Plan Rates and Fees” | OHA schedules apply only to services billed FFS to OHA; CCO prices must be obtained from the CCO. | Current OHA page checked 2026-11-25. | EOCCO hospice amounts remain unknown. No Medicare or OHA FFS price is promoted to an EOCCO rate. |

## Implementation status

- Migration 1536 adds an inclusive line-through date while leaving historical line spans `NULL` when they
  cannot be reconstructed. New hospice and R&B lines persist their exact line end date.
- Rate rows now carry source class, canonical payer and verification state. Existing rows default to
  `legacy_unqualified` / `unverified`; no historical claim amount or rate row is rewritten as qualified.
- Persisted claim assembly continues to select no hospice rate. L8A.1 adds a separate read-only preview
  that invokes the payer-policy selector and pricing engine. In the current repository integration,
  authoritative CBSA/locality, election-day, quality-reporting, actual clinical quantity and provider
  usual-charge evidence readers are not bound; these missing facts remain explicit unresolved/partial
  preview segments and cannot create a persisted claim amount.
  Update (2026-11-25, L8A.2R, migration 1551): this paragraph and the "priced claim assembly remains
  refused" sentence below describe the L8A.1 state. Persisted assembly now prices a hospice routine home
  care (RHC) line when the stored billing evidence and the verified rate resolve, and stores the price in an
  append-only pricing snapshot; every other service category, and any RHC line whose evidence does not
  resolve, is still refused. See the L8A.2R and L8A.2C qualification records.
- The engine supports exact payer/provider/locality selection, inclusive effective-date segmentation,
  quality-reporting variants, open-ended final RHC buckets, evidence-bound daily/hourly arithmetic,
  policy rounding and explicit charge-ceiling methods. Unsupported in-home respite remains unpriceable;
  M6 does not yet supply that service type or its quantity contract. No rates are loaded, no source values
  are fabricated, and a CCO never falls back to OHA FFS or the historical shared schedule.
- L2B adds an append-only, payer-scoped notification/authorization observation ledger and a
  policy-neutral projection. Clinical document availability, notice preparation/sending, payer receipt,
  and authorization outcomes remain separate. The app role can only record unverified observations;
  verification requires a separate reviewer path. This lot adds no operator mutation endpoint, and
  `authorizationSatisfied` remains false because the payer's policy is unqualified. The 2025 manual is
  not enough to establish a current contractual effective date. Signed M6 CTI, election and plan records
  are clinical evidence, not payer acknowledgment or approval.
- L2B adds an empty tenant/provider-scoped rate evidence table for OHA FFS and future CCO contract source
  classes, including payer identity, exact locality, service/unit/bucket, quality-reporting state,
  optional charge ceiling, effective dates, secured source-document reference, reviewer provenance and
  append-only version lineage. No EOCCO or OHA amount is loaded or verified. L8A.1 extends the selector
  for exact payer/provider/geography/unit/date and quality-status variants, catches partial overlaps,
  and distinguishes correction/revocation lineage. Only the read-only preview calls it; priced claim
  assembly remains refused.
- Migration 1537 replaces nullable rate-schedule uniqueness with `UNIQUE NULLS NOT DISTINCT`; a
  duplicate preflight aborts with remediation guidance and does not merge or delete rows. Migrations
  1535-1539 applied to a fresh isolated PostgreSQL 18 container during qualification. Historical claim
  line `service_date_to` values remain NULL when their span is unknown.
- L2B adds a pure segmentation primitive for inclusive service windows and verified LOC, coverage,
  program, rate, policy and quantity boundaries. L8A.1 composes that primitive with verified locality and
  rate-period facts for read-only pricing segments. Daily units remain date-based; hourly units require
  explicit clinical minutes. M6 has no authoritative actual CHC-hours contract and no in-home respite
  service type, so those cases remain unresolved/blocked. L8A.1 does not persist segmented claim lines.
- Oregon adapter metadata no longer claims combined hospice/R&B support, a live channel, synchronous
  acknowledgment semantics or 817/818 replacement/void support. Its remaining 811-814 `supportedTobs` list reflects
  OHA FFS instructions only and does not qualify EOCCO; the list is declaration-only (no production code reads it),
  and `replacementTob`/`voidTob` still derive the standard 817/818, an open owner decision.
- Medicaid electronic submission remains unconditionally unavailable.

### L8A.2 clinical quantity and pricing-snapshot status — 2026-11-25

- The M24 preview's persisted rate reader now preserves the full as-of supersession lineage; it does not
  discard narrower successor rows merely because their `effective_to` does not overlap the complete claim
  window. The read is bounded and scoped to organization, provider, payer/program and state, and refuses
  an oversized history rather than truncating it.
- M24 reads M6 LOC periods inside the locked assembly transaction. The line snapshot validator now permits
  multiple contiguous daily segments in one LOC period and rejects gaps, overlaps, mismatched LOC facts,
  and historical lines with unknown `service_date_to`.
- These checks do not create a payer-rate snapshot. A non-overridable platform validation rule now keeps
  hospice lines without a current immutable payer-specific pricing snapshot from `READY`, including
  background revalidation. No new migration or claim-line pricing schema was added.
- The authoritative election-day sequence, billable CHC minutes, in-home respite service type/quantity,
  service-date CBSA/locality, payer-applicable provider quality status, actual institutional billed charge
  and qualified payer units/codes remain unresolved. The seven pricing-dependent assembly tests remain
  skipped until an evidence-backed persisted pricing path exists. See the [L8A.2 qualification report](./M24_1075_L8A2_CLINICAL_QUANTITY_AND_PRICING_SNAPSHOT_QUALIFICATION_20261125.md).
- No OHA or EOCCO rate, clinical quantity, locality, quality status, authorization or claim charge was
  invented. F04 and F06 remain open; F07 is only partially addressed. Medicaid submission remains disabled.

### L8A.2C advanced clinical quantity and evidence-lineage qualification — 2026-11-25

- Migration 1552 extends the append-only M24 billing-evidence correction identity through patient and
  program scope, requires version progression, and disallows correction branches. The RHC evidence reader
  uses assessment-time lineage and refuses partial-overlap heads that the current snapshot cannot segment.
- M8's existing signed encounter reader now projects its persisted provider, signed state, interval,
  time-source and source version. M24 only links a record matching organization/provider/patient/admission
  and its service window. A focused CHC quantity observer can split actual signed minutes across local
  service days; this does not establish payer eligibility, an hourly reimbursement policy or institutional
  units, and no CHC-priced claim line is persisted.
- The private live M24 assembly/RLS suite passed 28 cases with 6 explicit skips; the 6 are listed with
  prerequisites in the [L8A.2C qualification report](./M24_1075_L8A2C_ADVANCED_CLINICAL_PRICING_QUALIFICATION_20261125.md).
  It preserves the already-qualified synthetic RHC daily persistence path but does not deliver the requested
  generalized category snapshot architecture or positive persisted CHC/IRC/GIP pricing paths.
- L8A.2C was blocked at its implementation cutoff; L8A.2C1 subsequently adds one explicit assisted-living
  RHC/Q5002 local-draft profile and generalized daily snapshot version 2, while preserving version 1 home
  RHC/Q5001. Adjacent verified billing-evidence spans are now segmented into separately sourced lines.
  Election-day buckets, qualified CHC billing, IRC continuity, GIP inpatient pricing, in-home respite,
  production locality/quality evidence and payer-certified formats remain unsupported. F04/F06/F07/F11/F14
  remain open or partial. Migrations 1553–1554 are `contract` and remain subject to the deployment hold;
  no production catalog or migration was changed. See the [L8A.2C1 qualification report](./M24_1075_L8A2C1_GENERALIZED_DAILY_PRICING_QUALIFICATION_20261125.md).

### L8A.1 implementation and source recheck (2026-11-25)

- The official [OHA FY2027 hospice rate memo](https://www.oregon.gov/oha/HSD/OHP/Announcements/Hospice-Rates1026.pdf)
  and [rate schedule](https://www.oregon.gov/oha/HSD/OHP/Tools/Hospice-Rates100126.pdf) state that the
  schedule applies to FFS hospice service from 2026-10-01 through 2027-09-30, describes CBSA locality,
  the RHC day-61 split and quality-reporting-related rate treatment. OHA's [fee schedule guidance](https://www.oregon.gov/oha/hsd/ohp/pages/fee-schedule.aspx)
  says its FFS rates apply to services billed FFS to OHA and directs CCO rate questions to the CCO.
  Oregon's current [Division 142 rules page](https://secure.sos.state.or.us/oard/displayDivisionRules.action?selectedDivision=1729)
  was reopened. The current official values were not copied into fixtures or code.
- Migration 1550 adds explicit rate methodology, unit conversion, minimum-duration, rounding, ceiling and
  quality-applicability fields; it supports an open-ended final bucket and distinct quality variants.
  Historical rows default to unqualified and remain ineligible. Because the migration replaces existing
  constraints, it is marked `contract` and remains subject to the normal deployment hold. It was applied
  only to a private disposable PostgreSQL instance for qualification.
- The deterministic engine returns only a reimbursement estimate when complete, evidence-bound inputs
  resolve. It never returns a billed charge, payer-allowed amount, payment, claim-posting instruction or
  submission permission. Actual M24 preview inputs remain incomplete, so a resolved synthetic unit test
  is not evidence of OHA or EOCCO pricing readiness.
- See [L8A.1 implementation and qualification](./M24_1075_L8A1_RATE_POLICY_PRICING_QUALIFICATION_20261125.md)
  for exact commands, results, evidence gaps, migration behavior and L8A.2 requirements.

### L2B qualification evidence (2026-11-22)

- `bun run test:m24:claim-line-assembly:live`: passed, 24 passed / 8 skipped. The skipped cases require
  priced assembly which remains intentionally unresolved; the suite includes no-persistence assertions
  for the rate-policy refusal.
- `bun run test:rls:live:m24`: passed, 31 tests against the isolated database, including cross-tenant
  denial, provider-entity isolation, append-only behavior, verification-write rejection and audit-reference
  redaction for both new evidence tables.
- Focused adapter and UI suites: 52 tests passed, covering segmentation, payer-rate matching,
  authorization lifecycle and wizard rendering.
- Assembly-preview route validation: 17 tests passed, including the patient-scoped read-audit category.
- `bun run openapi:emit`, `bun run client:gen`, `bun run openapi:check`, and `bun run client:check` all
  passed. `arch:migration-numbering`, `arch:migration-compat`, `arch:ddl`, `arch:tenancy`,
  `arch:tables`, and `arch:manifest-mirror` passed.
- A backend-wide scoped TypeScript check with `NODE_OPTIONS=--max-old-space-size=1024` ended in a
  JavaScript heap out-of-memory at the cap. The `packages/medicaid-adapters` project check passed;
  `packages/db` scoped typecheck also passed; backend-wide type qualification remains incomplete.
- `bun run arch:fitness` completed 50 gates with four failures: `arch:docling-lock` could not find
  `uv`; `arch:parity` reported the pre-existing orphan `packages/domain` and `packages/admin-ui-shell`
  directories; `arch:boundaries` hit its 2 GiB Node heap cap; and `arch:status-matrix` was stale before
  regenerating the report. After regeneration, `bun run arch:status-matrix` passed. The independent
  table-ownership, tenancy, DDL, migration, manifest, compliance and OpenAPI gates passed.
- **Update 2026-11-22 (PR #1088 review-fix pass):** the branch passes `bun run typecheck`, `bun run lint` and `bun run arch:fitness` on the PR head after the review-fix pass (run on the integrated branch before push); the backend-wide typecheck out-of-memory and the `arch:fitness` failures recorded above describe the bounded local runs made at the time and are superseded for typecheck and architecture-fitness status. The M40/M24 provenance migration is ordinal 1541. This records the gate status for the PR head and names no commit, because the head moves with every fix; it is not a new qualification of this lot's behaviour, and full `bun run test` is not part of this update.

## External evidence still required

### L3 follow-up status (2026-11-22)

- A deterministic M24 institutional document mapper and explicitly synthetic fixture pathway now reuse the shared X12 837I serializer. The shared member identity contract is generic for Medicaid while preserving M23's `mbi` caller compatibility and Medicare filing default.
- Synthetic line checks preserve inclusive service spans; the unit basis is limited to the 837I SV204 units UN and DA (hour and minute bases are refused); daily quantities must match inclusive days. Missing clinical, code, price, payer or route facts remain gaps. This validates representation only; it does not qualify Oregon billing units or EOCCO coding.
- Offline mappers represent Stedi institutional JSON, Stedi raw X12, and Claim.MD multipart 837I upload contracts. They do not instantiate transports or certify vendor acceptance. All synthetic route values are inert fixtures.
- Synthetic acknowledgment helpers reuse shared 999 parsing, 277CA control/date reading and stage routing, and only correlate in memory. They do not process vendor webhooks, persist attempts, advance claims or imply payment.
- Focused L3 test coverage and exact statuses are recorded in `M24_1075_L3_TECHNICAL_QUALIFICATION_20261122.md`. No PostgreSQL objects changed in L3, so no migration/RLS qualification was needed for this increment.
- Medicaid electronic submission, vendor/payer transactions, ERA delivery, and production activation remain disabled and unqualified.

## External evidence still required

1. EOCCO's current hospice policy/contract exhibit, effective dates, notification acknowledgment and
   authorization reference/validity semantics, including inpatient LOC handling.
2. Provider-specific EOCCO rate agreement, including adjustments, effective periods, unit definitions
   and charge ceilings.
3. The provider's authoritative service CBSA and hospice election/benefit-period day source, plus current
   OHA quality-reporting status for FFS pricing.
4. EOCCO institutional companion guide for type of bill, revenue codes, service units, correction/void
   frequency and required supporting values.
