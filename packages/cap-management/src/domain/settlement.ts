import { computeInpatientOverage } from "./inpatient";
// @wardenx/cap-management — the cap-year settlement calculation (§2.1 cap_settlement). At year-close the
// final paid total is compared to the methodology-derived aggregate cap; the signed overage drives the
// owed-direction. Positive aggregate overage = the hospice was overpaid and owes CMS back; negative =
// underpaid (rare). The inpatient overage is a separate recoupment computed at the RHC differential.
import { agencyAllocatedCap } from "./methodology";
import type { Methodology, SettlementDirection } from "./types";

export interface SettlementInput {
  readonly perBeneficiaryCapCents: number;
  readonly methodology: Methodology;
  /** One weight per beneficiary (1.0 each under streamlined; fractional under proportional). */
  readonly beneficiaryWeights: readonly number[];
  /** Final paid total across all beneficiaries (cents), validated against PS&R where a reconciled import exists. */
  readonly paidTotalCents: number;
  readonly inpatientDays: number;
  readonly totalPatientDays: number;
  readonly inpatientCapPct?: number;
  readonly rhcDifferentialCentsPerDay?: number;
}

export interface SettlementResult {
  readonly beneficiaryCount: number; // head-count (weights.length)
  readonly aggregateCapAmountCents: number;
  readonly aggregateOverageCents: number; // signed: + = owed back to CMS
  readonly direction: SettlementDirection;
  readonly inpatientTotalDays: number;
  readonly inpatientOverageDays: number;
  readonly inpatientOverageCents: number;
}

/** The owed-direction for a signed aggregate overage. */
export function settlementDirection(aggregateOverageCents: number): SettlementDirection {
  if (aggregateOverageCents > 0) return "overpayment_owed_to_cms";
  if (aggregateOverageCents < 0) return "underpayment_owed_to_provider";
  return "balanced";
}

/** Compute the full settlement worksheet from final accruals + the locked methodology. */
export function computeSettlement(input: SettlementInput): SettlementResult {
  const { capCents } = agencyAllocatedCap(
    input.perBeneficiaryCapCents,
    input.methodology,
    input.beneficiaryWeights,
  );
  const aggregateOverageCents = input.paidTotalCents - capCents;
  const inpatient = computeInpatientOverage({
    inpatientDays: input.inpatientDays,
    totalPatientDays: input.totalPatientDays,
    inpatientCapPct: input.inpatientCapPct,
    rhcDifferentialCentsPerDay: input.rhcDifferentialCentsPerDay,
  });
  return {
    beneficiaryCount: input.beneficiaryWeights.length,
    aggregateCapAmountCents: capCents,
    aggregateOverageCents,
    direction: settlementDirection(aggregateOverageCents),
    inpatientTotalDays: input.inpatientDays,
    inpatientOverageDays: inpatient.overageDays,
    inpatientOverageCents: inpatient.overageCents,
  };
}
