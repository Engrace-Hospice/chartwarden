# ADR-0016 — Medicare hospice claim correctness: rates, wage index, CHC/IRC, 837I wire content, late-NOE

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 4 (Medicare correctness)
- **Resolves:** M23-F02/F04/F05/F09/F13/F15 (RHC/SIA already in ADR-0001; cap year in ADR-0002)
- **Depends on:** [ADR-0001](ADR-0001-rhc-two-tier-rate.md), [ADR-0002](ADR-0002-hospice-cap-year.md)
- **Changes:** `WARDENX_MODULE_23_BILLING_MEDICARE_SPEC`

## Context

M23's payment math and claim wire-content are wrong in ways that make every claim RTP (return to
provider) or systematically over/under-paid. ADR-0001 already fixed the RHC day-60 tiering and SIA;
this ADR fixes the remaining claim-correctness blockers.

## Decision

### D1 — Real base-rate table + labor-share wage index keyed by site-of-service CBSA (M23-F02)

- Per-diem rates come from the **annual CMS hospice base-rate table** (RHC-high, RHC-low, CHC
  hourly, IRC, GIP), version-pinned per federal fiscal year, never hard-coded.
- The wage index adjusts **only the labor-share portion** of each per-diem (RHC/CHC/IRC/GIP each have
  a published labor share), keyed by the **CBSA of the site of service** (the location where care is
  furnished) — **not** the CCN. Formula: `payment = (base × labor_share × CBSA_wage_index) + (base ×
  non_labor_share)`, then sequestration.

### D2 — CHC is hourly 15-minute units; IRC 5-day limit then RHC repricing (M23-F13)

- **Continuous Home Care (CHC):** paid **per hour in 15-minute increments**, requiring a minimum of
  **8 hours of predominantly skilled nursing care in a 24-hour day**; the daily amount = hourly rate
  × units. (The v0.4 spec modeled CHC as per-diem days.)
- **Inpatient Respite Care (IRC):** limited to **5 consecutive days** per respite stay; **day 6 and
  after revert to RHC pricing** (not blocked, not paid at IRC).

### D3 — 837I wire content that produces a compliant claim (M23-F04)

Every claim carries, at minimum: claim-level **principal (terminal) diagnosis** + related/unrelated
ICD-10 with sequence; **attending physician NPI** (matched to the election-designated attending,
M23-F15) and **certifying physician**; **value codes 61** (CBSA) and **G8**; **occurrence codes**
(e.g., 27 = cert/recert date) and **condition codes**; **patient status code**; **revenue-code
level-of-care lines** (0651/0652/0655/0656) with the site-of-service **Q-code**; and the
**per-discipline visit G-codes** (physician/NP, RN, MSW, aide) including the SIA G0299/G0155 lines
(ADR-0001). A claim missing any required element is blocked pre-submission, not RTP'd by the MAC.

### D4 — Late-NOE is provider-liable, not all-days-denied (M23-F05)

The NOE must be filed within **5 calendar days** of admission. When late, **only the days from
admission to the NOE receipt date are provider-liable** (non-covered, reported with **occurrence
span code 77**) — the claim still bills the covered days from the NOE date forward. The v0.4 spec
blocked then billed all days. The **CMS exception path** (4 enumerated circumstances) is encoded to
waive provider liability when granted.

### D5 — MA carve-out and IRC 5-day-then-RHC repricing (M23-F09/F13)

For a Medicare Advantage enrollee electing hospice, hospice services are billed **fee-for-service to
the MAC** (carved out of the MA plan) until the carve-in transition rules apply; M23 models the
carve-out correctly. IRC repricing per D2.

## Consequences

- M23 is re-specced against this rate/wire model in its Phase-4 reconciliation; the §11.A
  pre-submission rules validate the 837I wire content and the late-NOE provider-liability split.
- M24 (Medicaid) and M26 (cap) inherit the corrected per-diem/rate substrate.
