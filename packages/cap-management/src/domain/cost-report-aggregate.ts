// @chartwarden/cap-management — the pure cap-period aggregate for the M27 cost-report Worksheet-E cap calc
// (D13). Penny-exact integer cents; the seam impl supplies the raw ledger sums (RLS-scoped), this kernel
// applies the settled-vs-unsettled rule. Before settlement the aggregate cap is per-beneficiary cap ×
// beneficiary count and payments are the accrued paid total; once a settlement is final, the settled
// figures are authoritative (they incorporate any reopen/true-up).

export interface CapAggregateInputs {
  readonly capYear: string;
  readonly perBeneficiaryCapCents: number; // cap_period.aggregate_cap_amount_cents (snapshot)
  readonly beneficiaryCount: number; // count of cap_beneficiary_accrual rows
  readonly paidTotalCents: number; // Σ cap_beneficiary_accrual.paid_cents
  readonly gipDays: number;
  readonly ircDays: number;
  readonly totalPatientDays: number; // cap_inpatient_accrual.total_patient_days
  /** cap_settlement.aggregate_cap_amount_cents when the settlement is final; else null. */
  readonly settledAggregateCapCents: number | null;
  /** cap_settlement.paid_total_cents when the settlement is final; else null. */
  readonly settledPaidTotalCents: number | null;
}

export interface CostReportCapAggregateResult {
  readonly capYear: string;
  readonly beneficiaryCount: number;
  readonly aggregateCapCents: number;
  readonly aggregatePaymentsCents: number;
  readonly inpatientDays: number;
  readonly totalMedicareDays: number;
}

/** Compute the cost-report cap aggregate (settled figures win once final; else accrual-derived). */
export function computeCostReportCapAggregate(i: CapAggregateInputs): CostReportCapAggregateResult {
  return {
    capYear: i.capYear,
    beneficiaryCount: i.beneficiaryCount,
    aggregateCapCents: i.settledAggregateCapCents ?? i.perBeneficiaryCapCents * i.beneficiaryCount,
    aggregatePaymentsCents: i.settledPaidTotalCents ?? i.paidTotalCents,
    inpatientDays: i.gipDays + i.ircDays,
    totalMedicareDays: i.totalPatientDays,
  };
}
