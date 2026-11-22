# M24-1075-L2 policy evidence register

Verified 2026-11-21 against public OHA, Oregon Secretary of State and EOCCO material. This register
records source facts and qualification limits; it does not certify a customer contract, payer companion
guide, provider enrollment, claim acceptance or production route.

| ID | Policy/source | Scope and effective dates | Verification | M24 consequence |
|---|---|---|---|---|
| OR-HSP-ELIG | [OAR 410-142-0040](https://secure.sos.state.or.us/oard/displayDivisionRules.action?selectedDivision=1729), subsection 0040 | Oregon Medicaid hospice benefit; current rule-history dates are shown by SOS. OHP Plus coverage and CTI are required; Medicare Part A hospice is billed to Medicare. | Current SOS rule page checked 2026-11-21. | Coverage and payer/program responsibility remain separate from clinical eligibility. |
| OR-HSP-CTI | [OAR 410-142-0060](https://secure.sos.state.or.us/oard/displayDivisionRules.action?selectedDivision=1729), subsection 0060 | Certification timing and signed written certification before claims for all benefit periods. | Current SOS rule page checked 2026-11-21. | M6 remains owner of CTI/election/clinical records; M24 does not copy them. |
| OR-HSP-LOC | [OAR 410-142-0260](https://secure.sos.state.or.us/oard/displayDivisionRules.action?selectedDivision=1729), subsection 0260 | Five LOCs: RHC, CHC, in-home respite, inpatient respite and GIP. CHC and in-home respite have day-boundary/minimum-hour rules; inpatient respite has a five-consecutive-day limit and NF-resident restriction. | Current SOS rule page checked 2026-11-21. | M24's M6 seam exposes only four clinical LOCs. In-home respite is not synthesized or mapped to an invented M6 value/revenue code. |
| OR-HSP-RATE | [OAR 410-142-0300](https://secure.sos.state.or.us/oard/displayDivisionRules.action?selectedDivision=1729), subsection 0300; [OHA FY2027 FFS hospice schedule](https://www.oregon.gov/oha/HSD/OHP/Announcements/Hospice-Rates1026.pdf) | OHA FFS only; schedule applies 2026-10-01 through 2027-09-30. Values vary by CBSA and include RHC day 1-60/day 61+, IRC, GIP, in-home respite and CHC per-hour amounts. OHA notes quality-reporting status can lower provider payment. | OHA memo dated 2026-10-01 and current SOS rule checked 2026-11-21. | Rates are not seeded: M24 lacks qualified CBSA, election-day count, usual-charge ceiling and quality-reporting inputs. No OHA FFS amount applies to EOCCO by inference. |
| OR-HSP-NF | [OAR 410-142-0290](https://secure.sos.state.or.us/oard/displayDivisionRules.action?selectedDivision=1729), subsection 0290 | Narrow nursing-facility hospice exception; qualifying NF hospice/R&B is billed directly to the Division even for CCO members. | Current SOS rule page checked 2026-11-21. | Does not establish a general hospice CCO carve-out or enable secondary R&B billing. |
| OR-OHA-UB | [OHA Institutional Claim Instructions](https://www.oregon.gov/oha/OHP/Providers/Tools/Institutional-Billing-Instructions.pdf), May 2022, hospice TOB table | OHA operational billing instructions; distinguishes hospital-based 82x from non-hospital 81x cadence. Not an EOCCO companion guide. | Published guide checked 2026-11-21; document itself says May 2022. | Adapter no longer advertises replacement/void TOBs or a production channel. CCO 837I coding remains unqualified. |
| EOCCO-HSP | [EOCCO Provider Manual 2025](https://www.eocco.com/eocco/-/media/eocco/pdfs/provider_manual.pdf), “Hospice care,” p. 35 | Manual states prior hospice notification including CTI, valid for initial six months; beyond that, PA request with care plan and recertification; inpatient hospice requests are reviewed. Manual does not state a hospice-policy effective date. | Public 2025 manual checked 2026-11-21. Current contractual applicability and exact six-month boundary require EOCCO confirmation. | Published rule is documented with current applicability unresolved. No local signature is treated as payer acknowledgment or approval. |
| EOCCO-RATE | [OHA fee schedule policy](https://www.oregon.gov/oha/hsd/ohp/pages/fee-schedule.aspx), “About Oregon Health Plan Rates and Fees” | OHA schedules apply only to services billed FFS to OHA; CCO prices must be obtained from the CCO. | Current OHA page checked 2026-11-21. | EOCCO hospice amounts remain unknown. No Medicare or OHA FFS price is promoted to an EOCCO rate. |

## Implementation status

- Migration 1536 adds an inclusive line-through date while leaving historical line spans `NULL` when they
  cannot be reconstructed. New hospice and R&B lines persist their exact line end date.
- Rate rows now carry source class, canonical payer and verification state. Existing rows default to
  `legacy_unqualified` / `unverified`; no historical claim amount or rate row is rewritten as qualified.
- M24 priced assembly currently selects no hospice rate. The required CBSA, election-day count, CHC
  hours, quality-reporting tier and usual-charge ceiling are not yet represented; the route returns
  `MEDICAID_RATE_POLICY_UNRESOLVED` rather than applying statewide or CCO prices without evidence.
- This is a protective gate, not a completed price engine. M24 still lacks qualified Oregon CBSA
  resolution, RHC election-day buckets, CHC hour units, usual-charge ceilings, provider
  quality-reporting differential and in-home respite service data. These cases must stay unresolved
  until the required facts and calculations are supplied and validated.
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
  append-only version lineage. No EOCCO or OHA amount is loaded or verified. A pure selector requires an
  exact payer/provider/geography/unit/date match and fails on duplicates or incomplete evidence. Claim
  assembly does not call this selector and retains `MEDICAID_RATE_POLICY_UNRESOLVED`.
- Migration 1537 replaces nullable rate-schedule uniqueness with `UNIQUE NULLS NOT DISTINCT`; a
  duplicate preflight aborts with remediation guidance and does not merge or delete rows. Migrations
  1535-1539 applied to a fresh isolated PostgreSQL 18 container during qualification. Historical claim
  line `service_date_to` values remain NULL when their span is unknown.
- L2B adds a pure segmentation primitive for inclusive service windows and verified LOC, coverage,
  program, rate, policy and quantity boundaries. Daily units remain date-based; hourly units require
  explicit clinical minutes. M6 has no authoritative actual CHC-hours contract and no in-home respite
  service type, so those cases remain unresolved/blocked. M24 continues not to price segmented output.
- Oregon adapter metadata no longer claims combined hospice/R&B support, a live channel, synchronous
  acknowledgment semantics or 817/818 replacement/void support. Its remaining 811-814 TOB list reflects
  OHA FFS instructions only and does not qualify EOCCO.
- Medicaid electronic submission remains unconditionally unavailable.

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

## External evidence still required

### L3 follow-up status (2026-11-22)

- A deterministic M24 institutional document mapper and explicitly synthetic fixture pathway now reuse the shared X12 837I serializer. The shared member identity contract is generic for Medicaid while preserving M23's `mbi` caller compatibility and Medicare filing default.
- Synthetic line checks preserve inclusive service spans and unit basis; daily quantities must match inclusive days, and clinical-minute quantities require explicit evidence. Missing clinical, code, price, payer or route facts remain gaps. This validates representation only; it does not qualify Oregon billing units or EOCCO coding.
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
