// @wardenx/ai-platform — §4.2.5 `DenialOutcomePredictionProvider` (M32-T06).
//
// Consumed by M25 (deny-stub Phase 1). ADVISORY ONLY: §4.2.5 is explicit that it "never gates
// submission", so an unavailable answer must never stop a claim going out the door — which is exactly
// why the refusal is a value and not a throw.
//
// LOCAL-ONLY MODEL. §2.4 registers `denial_outcome_prediction` with `defaultBackendKey: null` (tabular
// ML on the `local-ml-worker` sidecar, D15), so no Anthropic dependency is on this path even in Phase 2.
import type { AiSeamRefusal } from "./common";

/** §4.2.5's claim features. `billedAmount` is in CENTS — M23/M25 carry money as integer minor units and
 *  a float here would round a denial probability off a rounding error. */
export interface DenialPredictionClaimFeatures {
  readonly payer: string;
  readonly revenueCode: string;
  readonly hcpcsCode: string;
  /** Integer cents. */
  readonly billedAmount: number;
  readonly patientLengthOfStayDays: number;
  readonly priorAuthOnFile: boolean;
  /** §4.2.5's "…additional features locked in M25 spec". Open by construction, so M25 can widen the
   *  feature vector without a change here; unknown keys are the model's problem, not the seam's. */
  readonly additionalFeatures?: Readonly<Record<string, unknown>>;
}

export interface DenialPredictionInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly claimId: string;
  readonly claimFeatures: DenialPredictionClaimFeatures;
}

export type DenialPredictionResult =
  | {
      readonly available: true;
      readonly invocationId: string;
      /** [0, 1]. */
      readonly denialProbability: number;
      readonly topFactors: readonly { readonly factor: string; readonly contribution: number }[];
      readonly modelVersionPin: string;
    }
  | AiSeamRefusal;

/** §4.2.5 — probability of claim denial given claim features. Advisory; never gates submission. */
export interface DenialOutcomePredictionProvider {
  predict(input: DenialPredictionInput): Promise<DenialPredictionResult>;
}
