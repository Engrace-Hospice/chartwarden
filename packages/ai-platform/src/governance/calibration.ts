// @wardenx/ai-platform — §3.2.3 calibration publication rules (M32-T03, R5/W6).
//
// A calibration is the (capability, backend) pair's THRESHOLDS plus the metric baseline the W7 drift
// monitor measures the live window against. Publishing one is therefore two writes, never one: the
// incumbent `is_current=true` row is superseded and a new one is inserted. `ai_cap_calib_current_per_
// backend_idx` is a PARTIAL unique index over `is_current = true`, so doing only the insert is not a
// silently-wrong result — it is a constraint violation. This file produces the PLAN for both writes so
// the store cannot perform one without the other.
//
// THRESHOLDS ARE PER (CAPABILITY, BACKEND), NOT PER CAPABILITY, and that is the point of AI Governance
// §10.10's trade-off disclosure: the same capability has a materially different hallucination rate on
// Claude Opus than on a local Llama, and a tenant that chose `local_only` is entitled to be measured
// against the baseline of the model that actually ran. A calibration published for a backend the
// capability may never route to has no traffic to measure and would sit in front of the drift monitor
// looking live — hence the allowed-backends guard.
//
// THE BASELINE RUN IS MANDATORY AND THE SUPERSEDE REASON IS CONDITIONALLY SO. §3.2.3 makes
// `baseline_evaluation_run_id` NOT NULL (a baseline nobody measured is not a baseline) and leaves
// `superseded_reason` nullable — correctly, because the FIRST baseline supersedes nothing. The moment
// there IS an incumbent, though, "why did the numbers change" is the only question the W6 promotion
// history exists to answer, so the reason becomes required exactly then.
import { aiGovernanceRefusal, type AiGovernanceRefusal } from "./errors";

/** The `ai_capability` columns the calibration gate reads. */
export interface AiCalibrationCapabilitySnapshot {
  readonly defaultBackendKey: string;
  readonly allowedBackendKeys: readonly string[];
}

/** The incumbent `is_current=true` row for the (capability, backend) pair, if any. */
export interface AiCurrentCalibration {
  readonly id: string;
  readonly backendKey: string;
}

/** R5's body, already parsed. */
export interface AiCalibrationPublicationRequest {
  readonly backendKey: string;
  /** Typed PerCapabilityThresholds — opaque here; the shape is the capability's own (§2.5). */
  readonly thresholds: unknown;
  readonly baselineMetrics: unknown;
  readonly baselineSetAt: string;
  readonly baselineEvaluationRunId: string | null;
  /** Required iff there is an incumbent to supersede (see header). */
  readonly supersededReason: string | null;
}

/** The two writes a publication is. */
export interface AiCalibrationPublicationPlan {
  /** `null` on the first baseline for this (capability, backend). */
  readonly supersede: {
    readonly calibrationId: string;
    readonly supersededReason: string;
    readonly supersededAt: string;
  } | null;
  readonly insert: {
    readonly backendKey: string;
    readonly thresholds: unknown;
    readonly baselineMetrics: unknown;
    readonly baselineSetAt: string;
    readonly baselineEvaluationRunId: string;
    readonly isCurrent: true;
  };
}

export type AiCalibrationDecision =
  | { readonly ok: true; readonly plan: AiCalibrationPublicationPlan }
  | AiGovernanceRefusal;

/** The backends a capability may route to — `allowed_backend_keys` plus its own default. */
export function aiRoutableBackendKeys(
  capability: AiCalibrationCapabilitySnapshot,
): readonly string[] {
  return capability.allowedBackendKeys.includes(capability.defaultBackendKey)
    ? capability.allowedBackendKeys
    : [capability.defaultBackendKey, ...capability.allowedBackendKeys];
}

/** Plan a calibration publication, or refuse it. Pure. */
export function evaluateAiCalibrationPublication(
  capability: AiCalibrationCapabilitySnapshot,
  current: AiCurrentCalibration | null,
  request: AiCalibrationPublicationRequest,
  at: string,
): AiCalibrationDecision {
  const routable = aiRoutableBackendKeys(capability);
  if (!routable.includes(request.backendKey)) {
    return aiGovernanceRefusal(
      "AI_CALIBRATION_BACKEND_NOT_ALLOWED",
      `${request.backendKey} is not among the capability's routable backends [${routable.join(", ")}]`,
    );
  }

  if (!request.baselineEvaluationRunId) {
    return aiGovernanceRefusal(
      "AI_CALIBRATION_EVALUATION_RUN_REQUIRED",
      "ai_capability_calibration.baseline_evaluation_run_id is required (§3.2.3)",
    );
  }

  const reason = request.supersededReason?.trim() ?? "";
  if (current !== null && reason.length === 0) {
    return aiGovernanceRefusal(
      "AI_CALIBRATION_SUPERSEDE_REASON_REQUIRED",
      `superseding calibration ${current.id} requires a reason`,
    );
  }

  return {
    ok: true,
    plan: {
      supersede:
        current === null
          ? null
          : { calibrationId: current.id, supersededReason: reason, supersededAt: at },
      insert: {
        backendKey: request.backendKey,
        thresholds: request.thresholds,
        baselineMetrics: request.baselineMetrics,
        baselineSetAt: request.baselineSetAt,
        baselineEvaluationRunId: request.baselineEvaluationRunId,
        isCurrent: true,
      },
    },
  };
}
