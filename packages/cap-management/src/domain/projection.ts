// @wardenx/cap-management — the deterministic linear-extrapolation projection (D5, §1.2: "deterministic
// linear extrapolation", explicitly NOT AI/predictive). The projection is the bridge between "paid YTD" and
// "what we will be paid by Sep 30": projectedYearEnd = paidYtd / elapsedFraction (a constant run-rate over
// the cap-year window). Accrual basis is PAID amount from M25 remittance (D4); outstanding-billed is carried
// alongside for visibility but never contaminates the canonical paidYtd or the band.
import { capYearWindow, elapsedFraction } from "../cap-year";
import { ratio, round4, roundCents } from "../money";
import { aggregateBand } from "./bands";
import type { AlertBand, Methodology } from "./types";

export interface AggregateProjectionInput {
  /** Canonical paid-to-date cents (sum of M25-derived accrual lines; signed reversals already applied). */
  readonly paidYtdCents: number;
  /** In-flight billed-not-yet-paid cents (display only — never enters the band, D4). */
  readonly outstandingBilledCents: number;
  /** The cap denominator: per-beneficiary cap (patient scope) or per-bene cap × beneficiary count (agency). */
  readonly capAmountCents: number;
  readonly capYear: string;
  /** As-of date (`YYYY-MM-DD`) — the extrapolation reference; defaults the run to the period window. */
  readonly asOf: string;
  readonly methodology: Methodology;
  /** Optional per-tenant tightened band thresholds (D7); defaults to the platform floor. */
  readonly thresholds?: { watch: number; warn: number; breach: number };
}

export interface AggregateProjectionResult {
  readonly paidYtdCents: number;
  readonly outstandingBilledCents: number;
  readonly projectedYearEndCents: number;
  readonly capAmountCents: number;
  /** projectedYearEnd / capAmount, rounded to the numeric(7,4) grain. 0 when the cap denominator is 0. */
  readonly pctOfCap: number;
  readonly alertBand: AlertBand;
}

/**
 * Compute the agency- or patient-aggregate projection. A period with no accruals yet returns
 * projectedYearEnd=0, pctOfCap=0, band='safe' (never null) — the seam contract guarantees a snapshot.
 */
export function computeAggregateProjection(
  input: AggregateProjectionInput,
): AggregateProjectionResult {
  const window = capYearWindow(input.capYear);
  const elapsed = elapsedFraction(window, input.asOf);
  const projectedYearEndCents = roundCents(input.paidYtdCents / elapsed);
  const pctOfCap = round4(ratio(projectedYearEndCents, input.capAmountCents));
  return {
    paidYtdCents: input.paidYtdCents,
    outstandingBilledCents: input.outstandingBilledCents,
    projectedYearEndCents,
    capAmountCents: input.capAmountCents,
    pctOfCap,
    alertBand: aggregateBand(pctOfCap, input.thresholds),
  };
}
