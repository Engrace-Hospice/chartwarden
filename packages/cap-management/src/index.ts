// @wardenx/cap-management — M26 Cap Management package entrypoint (public barrel).
//
// M26 is the deterministic, ledger-grade accounting of every Medicare hospice cap obligation under
// 42 CFR §418.308: the per-tenant cap_period lifecycle, the per-beneficiary + inpatient (20%) accrual
// ledger, the nightly projection + threshold-band alerts, PS&R reconciliation, and the year-close
// settlement worksheet. The Drizzle schema for all 12 owned tables lives in the central barrel
// (packages/db/src/schema/cap) per repo convention; this package holds the pure domain + the contract /
// seam / event / permission / ABAC / alert / eraser catalogs the backend projects from.
//
// Cap projection is warn-only and NEVER blocks clinical service (D14). Cap year = federal FY Oct 1–Sep 30
// (D1). Money is BIGINT cents (§2.3). No PHI beyond patient-id pointers; MBI is a join key, never logged.

/** The cap accounting year is the federal FY: Oct 1 – Sep 30 (BBA-2018 §51005(b); 42 CFR §418.309(b)). */
export const CAP_YEAR_START_MONTH = 10 as const; // October
export const CAP_YEAR_END_MONTH = 9 as const; // September

/** The platform-floor inpatient-cap percentage (GIP+IRC ≤ 20% of total Medicare hospice days). */
export const INPATIENT_CAP_PCT = 0.2 as const;

// ── kernels ────────────────────────────────────────────────────────────────────────────────────────
export * from "./money";
export * from "./cap-year";

// ── pure domain ──────────────────────────────────────────────────────────────────────────────────
export * from "./domain/types";
export * from "./domain/bands";
export * from "./domain/projection";
export * from "./domain/methodology";
export * from "./domain/inpatient";
export * from "./domain/settlement";
export * from "./domain/lifecycle";
export * from "./domain/psr";
export * from "./domain/cost-report-aggregate";

// ── contracts + catalogs ───────────────────────────────────────────────────────────────────────────
export * as contracts from "./contracts";
export * from "./seams";
export * from "./events";
export * from "./alerts";
export * from "./permissions";
export * from "./abac";
export * from "./eraser";
