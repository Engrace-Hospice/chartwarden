# ADR-0002 — Hospice aggregate-cap accounting year = Oct 1 – Sep 30

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 0 (architecture correction)
- **Resolves:** M23-F14, M26 (cap-year), ARCH-178; Build-Blocking #9
- **Changes:** `CHARTWARDEN_ARCHITECTURE_v0_11.md` §H Module 26 (CapPeriod entity)

## Context

The architecture defined `CapPeriod (Nov 1 – Oct 31)`. That is the **pre-2017** hospice cap
accounting year. Under 42 CFR 418.309 (as amended by the IMPACT Act and finalized for cap years
ending after Sept 30, 2016), the hospice aggregate cap and inpatient cap accounting year is the
**federal fiscal year: October 1 through September 30**.

Billing the wrong cap window mis-attributes beneficiary days and payments to the wrong cap year,
producing incorrect cap-overage calculations and incorrect self-reported repayments — a direct
CMS compliance and overpayment-recovery exposure. Module 26's spec had independently "corrected"
this with an unauthorized in-spec override (M26 BLOCKER for the mechanism; regulatorily correct);
this ADR makes the correct value authoritative at the architecture layer so M26 can drop the
override.

## Decision

The hospice cap accounting year is **October 1 – September 30** (federal fiscal year).

- `CapPeriod` is `(Oct 1 – Sep 30)`.
- Both the **aggregate (per-beneficiary) cap** and the **inpatient cap** (GIP + IRC day limit)
  accrue and reset on this Oct 1 – Sep 30 boundary.
- The proportional / streamlined cap-allocation methodology and the patient-by-patient vs.
  streamlined election are out of scope here (Phase 4, M26 re-lock); this ADR fixes only the
  **accounting-year boundary**.

## Consequences

- §11.A's "Aggregate cap projection" and "IPU cap projection" rules evaluate against the
  Oct 1 – Sep 30 year.
- Module 26 removes its in-spec cap-year override and inherits the corrected architecture value;
  Module 23/30 cap-watch projections re-anchor to Oct 1 – Sep 30.
- Any historical Nov 1 – Oct 31 references elsewhere in the corpus are defects to sweep in Phase 6.
