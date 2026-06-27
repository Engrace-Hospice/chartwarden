// @wardenx/quality — operational measure: verbal-order signature on time (CoP 418.104(b)). Pure. No IO.
// Rate of verbal orders signed within the agency-defined window (higher is better). Source: M11
// `OrderProvider.getVerbalOrderTimeliness`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched verbal-order timeliness counts. */
export interface VerbalOrderSignatureOnTimeInput extends ComputeMeasureInput {
  /** Verbal orders requiring signature in the window (denominator). */
  readonly totalVerbalOrders: number;
  /** Verbal orders signed within the agency window (numerator). */
  readonly signedOnTime: number;
  /** The per-FY/agency target (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target (yellow before red). */
  readonly warn?: ThresholdRule;
}

/** Compute the verbal-order-signature-on-time rate. Pure. */
export function computeVerbalOrderSignatureOnTime(
  input: VerbalOrderSignatureOnTimeInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.signedOnTime,
    denominator: input.totalVerbalOrders,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "verbal_order_signature_on_time",
      totalVerbalOrders: input.totalVerbalOrders,
      signedOnTime: input.signedOnTime,
    },
  });
}
