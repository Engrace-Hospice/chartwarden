// @wardenx/cap-management — M26 Cap Management package entrypoint (public barrel).
//
// M26 is the deterministic, ledger-grade accounting of every Medicare hospice cap obligation under
// 42 CFR §418.308: the per-tenant cap_period lifecycle, the per-beneficiary + inpatient (20%) accrual
// ledger, the nightly projection + threshold-band alerts, PS&R reconciliation, and the year-close
// settlement worksheet. The Drizzle schema for all 12 owned tables lives in the central barrel
// (packages/db/src/schema/cap) per repo convention; this package holds the pure domain (projection math,
// threshold bands, settlement calc, PS&R CSV schema), the published seam interfaces, the contract
// (TypeBox) shapes, the permission/ABAC/alert/outbox catalogs, and the destruction eraseFn contract.
//
// P1 scope: SCHEMA + MIGRATIONS only — the pure domain, seams, contracts, and catalogs land in P2
// (the @wardenx/cost-report / @wardenx/billing precedent). Cap projection is warn-only and never blocks
// clinical service (D14).

/** The cap accounting year is the federal FY: Oct 1 – Sep 30 (BBA-2018 §51005(b); 42 CFR §418.309(b)). */
export const CAP_YEAR_START_MONTH = 10 as const; // October
export const CAP_YEAR_END_MONTH = 9 as const; // September

/** The platform-floor inpatient-cap percentage (GIP+IRC ≤ 20% of total Medicare hospice days). */
export const INPATIENT_CAP_PCT = 0.2 as const;
