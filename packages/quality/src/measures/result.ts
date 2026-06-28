// @wardenx/quality — M30 measure-calculator KERNEL: the shared result/input contract every measure
// calculator in `measures/**` returns and consumes (§1.1, §3.3, §4.11). Pure domain — no IO.
//
// A measure calculator is a PURE function `(input) => QualityMeasureValueResult`. The worker phase (later)
// fetches the upstream-seam projections, shapes them into the per-calculator input type, calls the pure
// calculator, hashes the returned `computationSnapshot`, and persists a `quality_measure_value` row. These
// kernel symbols are the single source of truth for the numerator/denominator/rate/band shape so a
// surveyor-grade reproducibility question ("what was the value, and what drove it?") has one answer shape.
//
// NOTE (cycle-free barrel): these symbols live in this leaf and are RE-EXPORTED from `measures/index.ts`
// so the package surface still exposes them "from measures/index.ts" while keeping the calculator subtree
// free of an import cycle back into the barrel (the repo `no-circular` dependency-cruiser rule).
import type { schema } from "@wardenx/db";

/**
 * The opaque, calculator-version-specific reproducibility snapshot persisted on
 * `quality_measure_value.computation_snapshot` (audit-denylisted §3.6). Aliased from the FROZEN M30 db
 * type so the calculator output stays locked to the column shape — no drift.
 */
export type MeasureComputationSnapshot = schema.MeasureComputationSnapshot;

/**
 * The four-band public display color for a measure value (§4 `MeasureValueT.bandColor`). `insufficient_n`
 * is the deterministic outcome when the denominator is below the reportable floor (V — no threshold breach
 * fires and no QAPI indicator transitions on an `insufficient_n` value).
 */
export type MeasureBandColor = "green" | "yellow" | "red" | "insufficient_n";

/**
 * The base input every measure calculator accepts: the org + provider-entity it computes for and the
 * `[periodStart, periodEnd)` ISO-8601 window (V-3: `periodEnd > periodStart`). Per-measure input types
 * EXTEND this with the already-fetched upstream data the calculator reduces (the data fetch itself is the
 * worker's job — calculators are pure and never reach a seam or the DB).
 */
export interface ComputeMeasureInput {
  /** Canonical tenant scope (`app.org_id` RLS key, M34-F02). */
  readonly organizationId: string;
  /** The M40 provider entity the value is aggregated for (logical id). */
  readonly providerEntityId: string;
  /** ISO-8601 inclusive period start. */
  readonly periodStart: string;
  /** ISO-8601 exclusive period end. */
  readonly periodEnd: string;
}

/**
 * The pure result of one measure computation — the numerator/denominator/rate plus the band, the
 * threshold verdict (null when not threshold-evaluated or `insufficient_n`), and the reproducibility
 * snapshot. The worker maps this onto a `quality_measure_value` insert (it stamps id/hash/computedAt).
 */
export interface QualityMeasureValueResult {
  /** Count of population members satisfying the numerator predicate (V-2: ≥ 0). */
  readonly numerator: number;
  /** Count of population members in the denominator (V-2: ≥ 0). */
  readonly denominator: number;
  /** `numerator / denominator` in `[0, 1]`, or `null` when `bandColor === 'insufficient_n'`. */
  readonly rate: number | null;
  /** Whether the rate met the CMS/per-FY threshold; `null` when not evaluated or `insufficient_n`. */
  readonly thresholdMet: boolean | null;
  /** The public display band. */
  readonly bandColor: MeasureBandColor;
  /** Calculator-version-specific reproducibility snapshot (hashed by the worker). */
  readonly computationSnapshot: MeasureComputationSnapshot;
}

/** A directional threshold: `gte` = higher-is-better (meet at `>= value`); `lte` = lower-is-better. */
export type ThresholdDirection = "gte" | "lte";

/** A per-FY CMS threshold for a single measure/indicator (§4 `HCI_THRESHOLDS_v<FY>`). */
export interface ThresholdRule {
  /** The CMS-published cut value the rate is compared against. */
  readonly value: number;
  /** Comparison direction (which side of `value` counts as "met"). */
  readonly direction: ThresholdDirection;
  /** Human-readable description of the criterion (for snapshots / UI). */
  readonly label?: string;
}

/**
 * The reportable-denominator floor (D — CMS suppresses publicly-reported rates below a minimum N). Below
 * this the calculator returns an `insufficient_n` band with a `null` rate. Default 1; CMS measure specs
 * that mandate a higher floor pass `minDenominator` to {@link ratioResult}.
 */
export const INSUFFICIENT_N_MIN_DENOMINATOR = 1;

/** Evaluate a rate against a directional threshold. Pure. */
export function evaluateThreshold(rate: number, rule: ThresholdRule): boolean {
  return rule.direction === "gte" ? rate >= rule.value : rate <= rule.value;
}

/**
 * Build a {@link QualityMeasureValueResult} from a numerator/denominator and (optionally) a threshold +
 * warn band. The single reduction every calculator funnels through so the `insufficient_n` floor, the
 * `rate` math, and the green/yellow/red banding are uniform across all ~28 measures.
 *
 * Banding: `green` when the threshold is met; else `yellow` when a `warn` rule is supplied and met; else
 * `red`. With no threshold the verdict is `null` and the band defaults to `green` (the caller may override
 * via `band`). Below the denominator floor everything collapses to `insufficient_n` / `null`.
 */
export function ratioResult(args: {
  readonly numerator: number;
  readonly denominator: number;
  readonly snapshot: MeasureComputationSnapshot;
  readonly threshold?: ThresholdRule;
  readonly warn?: ThresholdRule;
  readonly band?: MeasureBandColor;
  readonly minDenominator?: number;
}): QualityMeasureValueResult {
  const floor = args.minDenominator ?? INSUFFICIENT_N_MIN_DENOMINATOR;
  if (args.denominator <= 0 || args.denominator < floor) {
    return {
      numerator: args.numerator,
      denominator: args.denominator,
      rate: null,
      thresholdMet: null,
      bandColor: "insufficient_n",
      computationSnapshot: args.snapshot,
    };
  }

  const rate = args.numerator / args.denominator;
  let thresholdMet: boolean | null = null;
  let bandColor: MeasureBandColor = args.band ?? "green";

  if (args.threshold) {
    thresholdMet = evaluateThreshold(rate, args.threshold);
    bandColor = thresholdMet
      ? "green"
      : args.warn && evaluateThreshold(rate, args.warn)
        ? "yellow"
        : "red";
  }

  return {
    numerator: args.numerator,
    denominator: args.denominator,
    rate,
    thresholdMet,
    bandColor,
    computationSnapshot: args.snapshot,
  };
}
