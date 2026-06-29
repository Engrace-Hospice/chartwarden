// @wardenx/cap-management — shared domain value types. These mirror the DB enums (packages/db/src/schema/cap)
// as string-literal unions so the pure domain never imports Drizzle. No PHI; ids are opaque strings.

export type Methodology = "streamlined" | "proportional";

export type ProjectionScope = "agency_aggregate" | "patient_aggregate" | "inpatient";

export type ProjectionTrigger = "nightly_batch" | "remittance_trigger" | "manual_recompute";

/** The full DB alert-band enum (m26_alert_band). Aggregate scopes use the first four; inpatient the last three. */
export type AlertBand =
  | "safe"
  | "watch_90"
  | "warn_95"
  | "breach_100"
  | "inpatient_safe"
  | "inpatient_watch_18"
  | "inpatient_breach_20";

export type PeriodStatus = "open" | "active" | "in_settlement" | "settled" | "reopened";

export type SettlementStatus = "proposed" | "reviewed" | "final";

export type SettlementDirection =
  | "overpayment_owed_to_cms"
  | "underpayment_owed_to_provider"
  | "balanced";

export type PsrReconScope = "beneficiary" | "agency_aggregate" | "inpatient";

export type PsrVarianceReason =
  | "timing"
  | "psr_correction"
  | "our_correction"
  | "mbi_mismatch"
  | "data_quality"
  | "unknown";

export type MacRegion = "ngs" | "cgs" | "palmetto" | "wps" | "noridian" | "first_coast" | "novitas";

/** D7 platform-floor band thresholds (fractions). Tenants may TIGHTEN (lower) but never loosen. */
export const BAND_THRESHOLDS = {
  aggregate: { watch: 0.9, warn: 0.95, breach: 1.0 },
  inpatient: { watch: 0.18, breach: 0.2 },
} as const;

/** PS&R per-line variance default that lands a row on the reconciliation queue (D9: $50 = 5000 cents). */
export const DEFAULT_PSR_VARIANCE_THRESHOLD_CENTS = 5000;
