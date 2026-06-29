// @wardenx/cap-management — the six published seam interfaces (§4.3) + the published-name tuple. Consumed by
// M23 (pre-submission validation), M27 (cost report), M30/M33 (reporting), M36 (alert recipient resolution).
// The backend registers the Drizzle-backed implementations into the M1 SeamRegistry in a later phase (the
// M27 seam-registration precedent). Monetary fields cross the seam as numeric STRINGS (cents-as-string) so a
// consumer never silently parses to a lossy JS float; day counts are plain numbers.
import { M26_PERMISSIONS } from "./permissions";

export type AggregateBandLabel = "safe" | "watch" | "warn" | "breach";
export type InpatientBandLabel = "safe" | "watch" | "breach";

// ── CapProjectionProvider (M23 §11.A pre-submission validation, M27, M33) ──────────────────────────
export interface AgencyProjectionView {
  capPeriodId: string;
  capYear: string;
  paidToDate: string;
  outstandingBilled: string;
  totalAllocatedCap: string;
  utilizationPct: number;
  band: AggregateBandLabel;
  computedAt: string;
}
export interface PatientProjectionView extends AgencyProjectionView {
  patientId: string;
  perBeneficiaryAllocatedCap: string;
  contributionToAgency: string;
  methodology: "streamlined" | "proportional";
}
export interface ProjectionAtDateView extends AgencyProjectionView {
  isFrozenSnapshot: boolean;
}
export interface CapProjectionProvider {
  getAgencyProjection(orgId: string, capPeriodId: string): Promise<AgencyProjectionView | null>;
  getPatientProjection(
    orgId: string,
    capPeriodId: string,
    patientId: string,
  ): Promise<PatientProjectionView | null>;
  getProjectionForServiceDate(
    orgId: string,
    serviceDate: string,
    scope: "agency_aggregate" | "patient_aggregate",
    patientId?: string,
  ): Promise<ProjectionAtDateView | null>;
  /**
   * The inpatient (20%) cap projection for the cap period that contains a service date (M23 §11.A
   * `ipu_cap_projection` rule). Date-keyed so the consumer (M23, which has the claim's service date but not a
   * capPeriodId) resolves it directly. Returns null when no cap period contains the date.
   */
  getInpatientProjectionForServiceDate(
    orgId: string,
    serviceDate: string,
  ): Promise<InpatientProjectionView | null>;
}

// ── InpatientCapProvider (M30, M33) ────────────────────────────────────────────────────────────────
export interface InpatientProjectionView {
  capPeriodId: string;
  inpatientDayCount: number;
  totalDayCount: number;
  utilizationPct: number;
  band: InpatientBandLabel;
  computedAt: string;
}
export interface InpatientCapProvider {
  getInpatientProjection(orgId: string, capPeriodId: string): Promise<InpatientProjectionView | null>;
  getInpatientDayCount(
    orgId: string,
    capPeriodId: string,
  ): Promise<{ inpatientDays: number; totalDays: number; computedAt: string } | null>;
}

// ── CapAccrualReader (M27 cost report, M33 audit reports) ──────────────────────────────────────────
export interface PatientAccrualView {
  patientId: string;
  capPeriodId: string;
  totalPaid: string;
  lineCount: number;
  firstPostingDate: string | null;
  lastPostingDate: string | null;
}
export interface AccrualLinePage {
  items: Array<{
    id: string;
    remittanceId: string;
    claimId: string;
    paidAmount: string;
    postingDate: string;
    serviceFromDate: string;
    serviceThruDate: string;
  }>;
  nextCursor: string | null;
}
/**
 * The cap-period AGGREGATE M27's CMS-1984-14 Worksheet-E cap calc + cap validation rules consume (D13).
 * Money is cents-as-string (the seam money convention — consumers parse to integer cents, never a float).
 * This is the read the M26 spec named `CapAccrualReader.aggregateForPeriod`, keyed by cap YEAR so the
 * consumer (M27, which knows only its fiscal year) never needs a capPeriodId.
 */
export interface CostReportCapAggregate {
  capYear: string;
  beneficiaryCount: number;
  aggregateCapCents: string; // per-beneficiary cap × beneficiary count (or the settled aggregate cap)
  aggregatePaymentsCents: string; // total Medicare payments (paid YTD, or the settled final)
  inpatientDays: number; // GIP + IRC
  totalMedicareDays: number; // all-LOC days (the inpatient-cap denominator)
}

export interface CapAccrualReader {
  getPatientAccrual(
    orgId: string,
    capPeriodId: string,
    patientId: string,
  ): Promise<PatientAccrualView | null>;
  listAccrualLines(
    orgId: string,
    capPeriodId: string,
    patientId: string,
    cursor?: string,
  ): Promise<AccrualLinePage>;
  /**
   * The cap-period aggregate for a cap year (M27 cost-report Worksheet-E inputs). Resolves the org's
   * cap_period for `capYear`, sums the accrual/inpatient ledgers, and uses the settled figures once a
   * settlement is final. Returns null when no cap period exists for that year.
   */
  aggregateForCostReport(orgId: string, capYear: string): Promise<CostReportCapAggregate | null>;
}

// ── CapSettlementProvider (M27 cost report) ────────────────────────────────────────────────────────
export interface CapSettlementView {
  id: string;
  capPeriodId: string;
  status: "proposed" | "reviewed" | "final";
  totalPaidFinal: string;
  totalCapFinal: string;
  varianceAmount: string;
  direction: "overpayment_owed_to_cms" | "underpayment_owed_to_provider" | "balanced";
  finalizedAt: string | null;
}
export interface CapSettlementProvider {
  getSettlement(orgId: string, capPeriodId: string): Promise<CapSettlementView | null>;
}

// ── CapAlertSubscriberProvider (M36 reads this to resolve cap-alert recipients; M36-F03) ──────────────
export interface CapAlertSubscriberProvider {
  listSubscribers(
    orgId: string,
  ): Promise<Array<{ userId: string; bands: Array<"watch" | "warn" | "breach"> }>>;
}

// ── CapMetricsProvider (M30 HQRP-adjacent, M33 executive dashboard; no PHI) ──────────────────────────
export interface CapMetricsView {
  capPeriodId: string;
  patientsInWatchBand: number;
  patientsInWarnBand: number;
  patientsInBreachBand: number;
  agencyBand: AggregateBandLabel;
  inpatientBand: InpatientBandLabel;
  projectedOveragePct: number;
  computedAt: string;
}
export interface CapMetricsProvider {
  getMetrics(orgId: string, capPeriodId: string): Promise<CapMetricsView>;
}

/** The six seam keys M26 publishes into the M1 SeamRegistry (the backend binds the implementations). */
export const M26_PUBLISHED_SEAMS = [
  "cap.projection-provider",
  "cap.inpatient-cap-provider",
  "cap.accrual-reader",
  "cap.settlement-provider",
  "cap.alert-subscriber-provider",
  "cap.metrics-provider",
] as const;

export type M26PublishedSeamKey = (typeof M26_PUBLISHED_SEAMS)[number];

/** The DB alert-band enum → the coarse seam band label (aggregate family). */
export function toAggregateBandLabel(
  band: "safe" | "watch_90" | "warn_95" | "breach_100" | string,
): AggregateBandLabel {
  if (band === "breach_100") return "breach";
  if (band === "warn_95") return "warn";
  if (band === "watch_90") return "watch";
  return "safe";
}

/** The DB alert-band enum → the coarse seam band label (inpatient family). */
export function toInpatientBandLabel(
  band: "inpatient_safe" | "inpatient_watch_18" | "inpatient_breach_20" | string,
): InpatientBandLabel {
  if (band === "inpatient_breach_20") return "breach";
  if (band === "inpatient_watch_18") return "watch";
  return "safe";
}

// Re-export to anchor the permission catalog to the seam module's consumers (M36 subscriber default
// population is "any user holding cap.event.read").
export const CAP_EVENT_READ_PERMISSION = M26_PERMISSIONS[5]; // "cap.event.read"
