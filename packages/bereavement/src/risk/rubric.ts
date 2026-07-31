// @wardenx/bereavement — D3 / D17 deterministic risk rubric (M16-T01 domain layout).
//
// Deterministic-first by AI Governance §17: a surveyor must be able to reproduce the tier from the captured
// feature vector. The Layer-2 M32 narrative (D3) adds clinical prose and can NEVER move the tier — that
// composition lives in the M16 service layer; this module is the reproducible half.
// PURE — no IO, `@wardenx/types`-only.

import type {
  BereavementConfidenceBand,
  BereavementDataCompleteness,
  BereavementRiskFactorInputs,
  BereavementRiskFactorName,
  BereavementRiskTier,
} from "@wardenx/types";

/**
 * D3 — the platform-floor factor weights. They sum to 1.0 over the full 8-factor vector, which is what makes
 * the D17 knowable-only divisor produce a comparable 0..1 score rather than a differently-scaled one.
 */
export const BEREAVEMENT_RISK_WEIGHTS: { readonly [K in BereavementRiskFactorName]: number } = {
  ambivalentRelationship: 0.18,
  suddenUnexpectedDeath: 0.15,
  priorUnresolvedLoss: 0.14,
  preExistingMentalHealth: 0.14,
  socialIsolation: 0.13,
  financialStrain: 0.1,
  primaryCaregiverRole: 0.1,
  activeSubstanceUse: 0.06,
} as const;

/** The 8 D17 factor names, in weight order. */
export const BEREAVEMENT_RISK_FACTOR_NAMES = Object.keys(
  BEREAVEMENT_RISK_WEIGHTS,
) as readonly BereavementRiskFactorName[];

/** D17 — the full vector is 8 factors; the completeness bands are counted against this. */
export const BEREAVEMENT_RISK_FACTOR_COUNT = 8 as const;

/**
 * D3 — the tier cutoffs on the normalized 0..1 score. Derived from the §7.3 worked example: a survivor with
 * prior-unresolved-loss + pre-existing-mental-health + social-isolation + primary-caregiver-role positive
 * and the rest negative scores 0.51 and must land `high`, so the `high` cutoff sits at 0.50.
 *
 * `complicated` is deliberately NOT reachable here: per D8 / §7.7 it is a PROMOTION written by a positive
 * complicated-grief screen, never a weighted-sum outcome. See {@link promoteTierForGriefScreen}.
 */
export const BEREAVEMENT_TIER_THRESHOLDS = {
  moderate: 0.25,
  high: 0.5,
} as const;

/** §7.7 — the PG-13-adapted complicated-grief screen's positive threshold (of a 52-point instrument). */
export const COMPLICATED_GRIEF_SCREEN_THRESHOLD = 25 as const;

/** The reproducible output of {@link computeBereavementRiskScore}. */
export interface BereavementScoredResult {
  /** D17 — the weighted positive share of the KNOWABLE factors, in [0, 1]. */
  readonly weightedScore: number;
  readonly tier: BereavementRiskTier;
  readonly dataCompleteness: BereavementDataCompleteness;
  readonly confidenceBand: BereavementConfidenceBand;
  readonly knownFactorCount: number;
  readonly unknownFactorCount: number;
  readonly factorsContributing: readonly BereavementRiskFactorName[];
  /** D17 — `minimal` completeness means the score is advisory only; M30's measure denominator excludes it. */
  readonly advisoryOnly: boolean;
}

/** D17 — the completeness band from the knowable-factor count (`partial` = ≥4 knowable, `minimal` = ≤3). */
export function dataCompletenessFor(knownFactorCount: number): BereavementDataCompleteness {
  if (knownFactorCount === BEREAVEMENT_RISK_FACTOR_COUNT) return "complete";
  return knownFactorCount >= 4 ? "partial" : "minimal";
}

/** D17 — the confidence band from the knowable-factor count. */
export function confidenceBandFor(knownFactorCount: number): BereavementConfidenceBand {
  if (knownFactorCount >= 6) return "HIGH";
  return knownFactorCount >= 4 ? "MEDIUM" : "LOW";
}

/** D3 — the tier for a normalized score. Never returns `complicated` (see the threshold doc). */
export function tierForScore(weightedScore: number): BereavementRiskTier {
  if (weightedScore >= BEREAVEMENT_TIER_THRESHOLDS.high) return "high";
  if (weightedScore >= BEREAVEMENT_TIER_THRESHOLDS.moderate) return "moderate";
  return "low";
}

/**
 * D3 + D17 — the deterministic scorer. `unknown` is a THIRD explicit value: it contributes neither a point
 * nor a penalty, and the divisor shrinks to the knowable weight so the result stays comparable across
 * vectors of different completeness. Treating `unknown` as `false` (D17's rejected alternative (a)) would
 * silently understate risk for exactly the external-source / transfer-from-hospital deaths the band exists
 * to describe.
 *
 * A vector with NO knowable factors scores 0 and bands `LOW`/`minimal` — the honest "we know nothing"
 * result, which the caller must surface as advisory rather than as a low-risk finding.
 */
export function computeBereavementRiskScore(
  inputs: BereavementRiskFactorInputs,
): BereavementScoredResult {
  let positiveWeight = 0;
  let knownWeight = 0;
  let knownFactorCount = 0;
  const factorsContributing: BereavementRiskFactorName[] = [];

  for (const name of BEREAVEMENT_RISK_FACTOR_NAMES) {
    const value = inputs[name];
    if (value === "unknown") continue;
    knownFactorCount += 1;
    knownWeight += BEREAVEMENT_RISK_WEIGHTS[name];
    if (value === true) {
      positiveWeight += BEREAVEMENT_RISK_WEIGHTS[name];
      factorsContributing.push(name);
    }
  }

  const weightedScore = knownWeight > 0 ? positiveWeight / knownWeight : 0;
  const dataCompleteness = dataCompletenessFor(knownFactorCount);

  return {
    weightedScore,
    tier: tierForScore(weightedScore),
    dataCompleteness,
    confidenceBand: confidenceBandFor(knownFactorCount),
    knownFactorCount,
    unknownFactorCount: BEREAVEMENT_RISK_FACTOR_COUNT - knownFactorCount,
    factorsContributing,
    advisoryOnly: dataCompleteness === "minimal",
  };
}

/**
 * D8 / §7.7 — a positive complicated-grief screen promotes the tier to `complicated` on the NEW score row;
 * a negative screen leaves the deterministic tier alone. The promotion is one-directional: a screen never
 * demotes a tier the rubric produced.
 */
export function promoteTierForGriefScreen(
  deterministicTier: BereavementRiskTier,
  screenScore: number | null,
): BereavementRiskTier {
  if (screenScore !== null && screenScore >= COMPLICATED_GRIEF_SCREEN_THRESHOLD) {
    return "complicated";
  }
  return deterministicTier;
}

/** §2.5 / D3 — a counselor tier override must carry a documented reason of at least this length, and lands
 *  as an immutable amendment row rather than an UPDATE (the audit trigger refuses UPDATE on score rows). */
export const RISK_TIER_OVERRIDE_REASON_MIN_LENGTH = 40 as const;

/**
 * The persistence scale (M16-T04). `bereavement_risk_score.rule_score` is an INTEGER column (§3.3.3) while
 * the D17 divisor produces a 0..1 fraction, so the stored value is the fraction in BASIS-POINT-free
 * hundredths: `0.51 → 51`. Multiplying rather than truncating keeps the column's "0..N deterministic sum"
 * semantic intact and keeps two scores comparable across vectors of different completeness, which is the
 * whole point of the D17 knowable-only divisor. The read seams divide back out
 * ({@link ruleScoreToWeighted}) so `BereavementDeterministicScore.score` stays the documented 0..1.
 */
export const BEREAVEMENT_RULE_SCORE_SCALE = 100 as const;

/** The `rule_score` integer for a 0..1 weighted score (rounds half-up; 0.505 → 51). */
export function weightedScoreToRuleScore(weightedScore: number): number {
  return Math.round(weightedScore * BEREAVEMENT_RULE_SCORE_SCALE);
}

/** The 0..1 weighted score behind a stored `rule_score` integer. */
export function ruleScoreToWeighted(ruleScore: number): number {
  return ruleScore / BEREAVEMENT_RULE_SCORE_SCALE;
}
