// @wardenx/cap-management — the two 42 CFR §418.309 beneficiary-counting methodologies (D2). Both are pure;
// the choice is locked per cap period at first accrual (cap_period_methodology_lock).
//
//   STREAMLINED  — each beneficiary who elected hospice with this provider during the cap year counts ONCE
//                  (weight 1.0), regardless of how the election spans cap years. Allocated cap per
//                  beneficiary = the full published per-beneficiary cap. A patient who transferred between
//                  hospices may be counted by BOTH (overlapping allocation — by design, D10).
//   PROPORTIONAL — each beneficiary counts as the FRACTION of their total hospice days that fell under THIS
//                  provider during the cap year (weight ∈ (0,1]). Allocated cap = per-beneficiary cap ×
//                  weight. Cross-hospice election days come from M6/M40; when unavailable the weight falls
//                  back to 1.0 (lifetime treatment within the tenant — §4.4 degraded path).
import { fromDecimal, RegulatoryDecimal } from "@wardenx/shared/money";
import { clamp, roundCents } from "../money";
import type { Methodology } from "./types";

/** A beneficiary's proportional weight inputs (election-day shares). */
export interface ProportionalWeightInput {
  /** Days this patient was on THIS provider's hospice election within the cap-year window. */
  readonly providerElectionDays: number;
  /** Total hospice election days across ALL providers in the cap year (M40-federated). 0 → fall back to 1.0. */
  readonly totalElectionDaysAllProviders: number;
}

/**
 * Proportional weight for one beneficiary (D10): providerDays / totalDays, clamped to (0,1]. When the
 * cross-hospice total is unknown (0 — M40 not federated), returns 1.0 (lifetime treatment, §4.4 fallback).
 */
export function proportionalWeight(input: ProportionalWeightInput): number {
  if (input.totalElectionDaysAllProviders <= 0 || input.providerElectionDays <= 0) return 1;
  return clamp(input.providerElectionDays / input.totalElectionDaysAllProviders, 0, 1);
}

/** Allocated per-beneficiary cap for one patient under the locked methodology (cents). */
export function perBeneficiaryAllocatedCap(
  perBeneficiaryCapCents: number,
  methodology: Methodology,
  weight: number,
): number {
  return methodology === "streamlined"
    ? perBeneficiaryCapCents
    : roundCents(perBeneficiaryCapCents * weight);
}

/** A beneficiary's contribution to the agency cap denominator (its weight): 1.0 streamlined, weight proportional. */
export function beneficiaryCountUnit(methodology: Methodology, weight: number): number {
  return methodology === "streamlined" ? 1 : clamp(weight, 0, 1);
}

/**
 * The agency aggregate cap denominator (cents): per-beneficiary cap × Σ beneficiary units. Under streamlined
 * the sum is the head-count; under proportional it is Σ weights (an effective fractional beneficiary count).
 * The Σ weights and the final cents multiply are both decimal-exact (PARAM-003): a national-chain agency
 * can sum thousands of `numeric(7,6)` proportional weights here, and plain-float accumulation drifts across
 * that many terms in a way a per-beneficiary cent figure should never carry.
 */
export function agencyAllocatedCap(
  perBeneficiaryCapCents: number,
  methodology: Methodology,
  beneficiaryWeights: readonly number[],
): { capCents: number; effectiveBeneficiaryCount: number } {
  const unitsDecimal = beneficiaryWeights.reduce(
    (sum, w) => sum.plus(beneficiaryCountUnit(methodology, w)),
    new RegulatoryDecimal(0),
  );
  return {
    capCents: fromDecimal(unitsDecimal.times(perBeneficiaryCapCents)),
    effectiveBeneficiaryCount: unitsDecimal.toNumber(),
  };
}
