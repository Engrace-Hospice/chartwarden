# ADR-0001 — Medicare RHC two-tier (day-60) rate; remove HIPPS-on-hospice construct; SIA mechanics

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 0 (architecture correction)
- **Resolves:** M23-F01, M23-F02, M23-F03; Medicare-Hospice gaps in `AUDIT_CONSOLIDATED_FINAL.md`; Build-Blocking #9
- **Changes:** `WARDENX_ARCHITECTURE_v0_11.md` §H Module 23, §11.A validation library

## Context

The architecture (§H Module 23, §11.A) encoded the Routine Home Care (RHC) per-diem as a
**HIPPS-coded "first 7 days vs. days 8+"** model and listed a `HippsCalculation` entity. This
is wrong on two counts, and produces noncompliant claims on day one:

1. **There are no HIPPS codes on hospice claims.** HIPPS is a Home Health / SNF PPS construct.
   Medicare hospice claims (TOB 81x) price RHC days directly from the per-diem rate table; they
   carry **no HIPPS rate code**. Emitting one causes claim rejection (RTP).
2. **The RHC two-tier boundary is day 60, not day 7.** Since FY2016 (80 FR 47142), RHC is paid
   at a **higher rate for days 1–60** and a **lower rate for day 61 and after** of the
   beneficiary's hospice election. The "first 7 days" figure conflated RHC tiering with the
   unrelated SIA last-7-days-of-life window.

The day count that selects the tier is **cumulative across the beneficiary's hospice election
history**, not reset per claim or per agency:

- Days count across **sequential hospice stays and across hospices** (the count follows the
  beneficiary, not the provider).
- A **gap in hospice election of more than 60 days** resets the count to day 1; a gap of 60
  days or fewer continues the prior count. (This is the standard CMS "60-day gap" reset.)

The SIA (Service Intensity Add-on) was also under-specified: it must be restricted to RHC days
in the **last 7 days of life**, paid in **15-minute units up to 4 hours/day**, for direct
patient care by an **RN (reported with G0299)** or **MSW/social worker (reported with G0155)**,
and not double-counted with CHC.

## Decision

1. **Delete the HIPPS construct from hospice billing.** Rename the `HippsCalculation` entity to
   **`PerDiemRateCalculation`** and remove all "HIPPS code" language from §11.A. Hospice claims
   carry revenue-code level-of-care lines priced from the CMS hospice per-diem rate table; no
   HIPPS rate code is emitted.

2. **Encode RHC as a day-60 two-tier rate:**
   - **RHC-High** for cumulative election days **1–60**.
   - **RHC-Low** for cumulative election days **61+**.
   - The day counter is the beneficiary's **cumulative hospice election day count** across
     sequential stays and hospices, with a **>60-day election-gap reset** to day 1.
   - Wage-index and base-rate mechanics are out of scope for this ADR (see M23-F02 remediation
     in Phase 4) but the rate model must support labor-share wage-index adjustment keyed by the
     **site-of-service CBSA**, not the CCN.

3. **Encode SIA correctly:** RHC days only; last 7 days of life; **15-minute units, max 4
   hr/day**; RN visits on **G0299**, MSW visits on **G0155**; not combined with CHC days; not
   double-counted with other adjustments.

## Consequences

- §11.A's "HIPPS coding" validation rule is replaced by an **"RHC rate-tier coherence"** rule
  (verifies the day-60 boundary and the cumulative/gap-reset day count) and the SIA rule is
  tightened to the units/cap/G-code form above.
- Module 23 must be re-specced in Phase 4 against this model (base-rate table, CBSA wage index,
  CHC 15-minute hourly units, full 837I wire content). This ADR fixes the **architecture
  baseline** only; M23 remains FAIL until its own re-lock.
- No downstream module may reference `HippsCalculation` or a hospice HIPPS code.

## Implementation note (migration 1069)

The `HippsCalculation` entity is now `PerDiemRateCalculation` in code: table `hipps_calculation` ->
`per_diem_rate_calculation` (columns `hipps_code` -> `per_diem_class_code`, `hipps_rate_cents` ->
`per_diem_rate_cents`), rule key `hipps_coding_correct` -> `per_diem_class_coding_correct`. The stored 5-character
value is an internal per-diem class placeholder and is never transmitted on a claim
(`packages/billing/__tests__/no-hipps-on-claim.test.ts` guards this).

API field names follow the rename: the claim-detail `pricing.hipps` block is now `pricing.perDiemClass` and its
`hippsRateCents` is `perDiemRateCents` (OpenAPI + typed client regenerated). Values persisted before migration 1069
in append-only history are NOT rewritten (`validation_result.rule_key` `hipps_coding_correct`, remediation `fixAction`
`recompute_hipps`, `segments[*].hippsCharPosition`); readers map those legacy spellings onto the current ones
(`packages/billing/src/legacy-stored-aliases.ts`), and the mutable `validation_rule_config.rule_key` is renamed in place.
