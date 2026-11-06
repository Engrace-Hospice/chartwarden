// @chartwarden/quality — SRA 5×5 risk-matrix scoring arithmetic (M30-P2a). Pure, IO-free.
//
// `sra_finding` carries an `inherent_5x5_score` and a `residual_5x5_score` (V-13): each is a
// likelihood × impact product on a 5×5 matrix (likelihood ∈ 1..5, impact ∈ 1..5 → score ∈ 1..25). This
// module is the pure arithmetic: validate the factors / score, compute the product, map a score to its
// risk band, and compute the residual reduction. The risk band feeds the §4.3 `SecurityRiskAssessmentReader`
// seam's `getOpenFindingsBands` breakdown (critical / high / medium / low). No IO.
import { ChartWardenError } from "@chartwarden/types";

/** The inclusive bounds of a single 5×5 factor (likelihood or impact). */
const RISK_FACTOR_MIN = 1;
const RISK_FACTOR_MAX = 5;

/** The inclusive bounds of a 5×5 score (likelihood × impact). */
const RISK_SCORE_MIN = 1;
const RISK_SCORE_MAX = 25;

/** The risk band a 5×5 score falls into (matches the `SecurityRiskAssessmentReader` seam breakdown). */
export type RiskBand = "low" | "medium" | "high" | "critical";

/**
 * The 5×5 score → band thresholds (inclusive upper bounds): 1–4 low, 5–9 medium, 10–15 high, 16–25
 * critical. The boundaries follow the conventional NIST-style 5×5 heat-map quartiling.
 */
const RISK_BAND_UPPER_BOUNDS: Readonly<Record<Exclude<RiskBand, "critical">, number>> = {
  low: 4,
  medium: 9,
  high: 15,
};

/** Throw if `factor` is not an integer in 1..5 (a 5×5 likelihood or impact). */
function assertFactor(factor: number, label: string): void {
  if (!Number.isInteger(factor) || factor < RISK_FACTOR_MIN || factor > RISK_FACTOR_MAX) {
    throw new ChartWardenError(
      "RISK_FACTOR_OUT_OF_RANGE",
      `${label} must be an integer in ${RISK_FACTOR_MIN}..${RISK_FACTOR_MAX}`,
      422,
    );
  }
}

/**
 * Validate a 5×5 score (V-13): an integer in 1..25. Throws {@link ChartWardenError} `RISK_SCORE_OUT_OF_RANGE`
 * otherwise. Used to validate persisted `inherent_5x5_score` / `residual_5x5_score` values.
 */
function assertValid5x5Score(score: number): void {
  if (!Number.isInteger(score) || score < RISK_SCORE_MIN || score > RISK_SCORE_MAX) {
    throw new ChartWardenError(
      "RISK_SCORE_OUT_OF_RANGE",
      `a 5×5 risk score must be an integer in ${RISK_SCORE_MIN}..${RISK_SCORE_MAX}`,
      422,
    );
  }
}

/**
 * Compute a 5×5 risk score from its likelihood and impact factors. Throws {@link ChartWardenError}
 * `RISK_FACTOR_OUT_OF_RANGE` if either factor is outside 1..5. Returns the product (1..25).
 */
export function riskScore(likelihood: number, impact: number): number {
  assertFactor(likelihood, "likelihood");
  assertFactor(impact, "impact");
  return likelihood * impact;
}

/**
 * Map a validated 5×5 `score` to its {@link RiskBand}. Throws {@link ChartWardenError} `RISK_SCORE_OUT_OF_RANGE`
 * if the score is outside 1..25.
 */
export function riskBandFromScore(score: number): RiskBand {
  assertValid5x5Score(score);
  if (score <= RISK_BAND_UPPER_BOUNDS.low) return "low";
  if (score <= RISK_BAND_UPPER_BOUNDS.medium) return "medium";
  if (score <= RISK_BAND_UPPER_BOUNDS.high) return "high";
  return "critical";
}

/** Convenience: compute the score from factors and return its band in one call. */
export function riskBand(likelihood: number, impact: number): RiskBand {
  return riskBandFromScore(riskScore(likelihood, impact));
}
