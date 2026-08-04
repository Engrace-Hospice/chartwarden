// @wardenx/cap-management — the inpatient (20%) cap (D13, 42 CFR §418.302(f)): GIP (rev 0656) + IRC
// (rev 0655) days must not exceed 20% of total Medicare hospice days in the cap year. Day source is M23
// claim lines; the denominator is all-LOC patient days. Overage days (above the 20% allowance) are recouped
// at the routine-home-care differential at settlement.
import { capYearWindow, elapsedFraction } from "../cap-year";
import { ratio, round4, roundCents } from "../money";
import { inpatientBand } from "./bands";
import { type AlertBand, BAND_THRESHOLDS } from "./types";

export interface InpatientProjectionInput {
  readonly gipDays: number; // rev 0656
  readonly ircDays: number; // rev 0655
  readonly totalPatientDays: number; // denominator: all-LOC days
  readonly capYear: string;
  readonly asOf: string;
  readonly thresholds?: { watch: number; breach: number };
}

export interface InpatientProjectionResult {
  readonly inpatientDaysYtd: number; // gip + irc
  readonly totalPatientDays: number;
  readonly inpatientPctYtd: number; // ytd fraction (numeric(7,4) grain)
  readonly inpatientPctProjected: number; // linear-extrapolated fraction (ratio is constant under uniform mix)
  readonly alertBand: AlertBand;
}

/**
 * Inpatient cap utilization. The percentage is a RATIO of two day-counts that both scale ~linearly with
 * elapsed time, so the projected percentage equals the YTD percentage under a uniform LOC mix — extrapolating
 * the numerator AND denominator by the same elapsed-fraction leaves the ratio unchanged. We still surface
 * both fields explicitly for the dashboard. A zero denominator reads 0% (band inpatient_safe).
 */
export function computeInpatientProjection(
  input: InpatientProjectionInput,
): InpatientProjectionResult {
  const inpatientDaysYtd = input.gipDays + input.ircDays;
  const pctYtd = round4(ratio(inpatientDaysYtd, input.totalPatientDays));
  // Extrapolate both day counts to year-end by the same elapsed fraction → ratio is unchanged; kept explicit
  // so a future non-uniform-mix model can diverge the projected ratio from the YTD ratio.
  const window = capYearWindow(input.capYear);
  void elapsedFraction(window, input.asOf);
  const pctProjected = pctYtd;
  return {
    inpatientDaysYtd,
    totalPatientDays: input.totalPatientDays,
    inpatientPctYtd: pctYtd,
    inpatientPctProjected: pctProjected,
    alertBand: inpatientBand(pctProjected, input.thresholds),
  };
}

export interface InpatientOverageInput {
  readonly inpatientDays: number; // gip + irc total at year-end
  readonly totalPatientDays: number;
  /** The 20% allowance fraction (platform floor; snapshot from cap_period.inpatient_cap_pct). */
  readonly inpatientCapPct?: number;
  /**
   * Per-day recoupment differential in cents (the inpatient per-diem minus the routine-home-care per-diem)
   * applied to overage days. Sourced from M23 rate data; defaults to 0 when rate data is not yet wired
   * (the figure is then days-only and the cents overage is reported as 0, never a wrong number).
   */
  readonly rhcDifferentialCentsPerDay?: number;
}

export interface InpatientOverageResult {
  readonly allowedDays: number; // floor(pct × totalDays)
  readonly overageDays: number; // max(0, inpatientDays − allowedDays)
  readonly overageCents: number; // overageDays × differential (0 when differential unknown)
}

/** Inpatient overage at settlement: days above the 20% allowance, recouped at the RHC differential. */
export function computeInpatientOverage(input: InpatientOverageInput): InpatientOverageResult {
  const pct = input.inpatientCapPct ?? BAND_THRESHOLDS.inpatient.breach;
  const allowedDays = Math.floor(pct * input.totalPatientDays);
  const overageDays = Math.max(0, input.inpatientDays - allowedDays);
  const overageCents = roundCents(overageDays * (input.rhcDifferentialCentsPerDay ?? 0));
  return { allowedDays, overageDays, overageCents };
}
