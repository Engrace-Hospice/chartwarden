// @wardenx/ai-platform — §3.2.11 / D10 / W6 evaluation runs, the pure half (M32-T05).
//
// An `ai_evaluation_run` row is the EVIDENCE a §2.2 lifecycle gate cites: D10 makes an evaluation run
// mandatory on the Stage-3, Stage-4 and re-approval edges, and `ai_capability_lifecycle_event`
// .linked_evaluation_run_id is where the citation lives. This file holds the run's own lifecycle and —
// the part that makes D10 real — the predicate that says whether a cited run actually supports the edge
// citing it.
//
// ── STATUS AND DECISION ARE TWO AXES, AND CONFLATING THEM IS THE BUG THE SCHEMA AVOIDS ────────────
//
// `status` is what the harness did (`pending` → `in_progress` → `passed`/`failed`/`aborted`).
// `decision` is what a human concluded (`approve_for_ga`, `reject`, `recalibrate_thresholds`, …), and
// §3.2.11 defaults it to `no_decision` so a finished run is visibly un-ruled-on rather than implicitly
// approved. The rules below keep the axes apart in the one direction that matters: a decision cannot be
// recorded before the run finished, and an APPROVAL cannot be recorded on a run that did not pass. The
// reverse is deliberately allowed — `reject` and `recalibrate_thresholds` are legal on a `failed` run,
// because "it failed and we are rejecting it" is exactly the ruling a failed run should carry.
//
// ── D10 EVIDENCE IS CHECKED AGAINST THE EDGE, NOT JUST FOR PRESENCE ───────────────────────────────
//
// M32-T03's lifecycle gate refuses a Stage-3 transition with NO `linkedEvaluationRunId`. That is the
// presence check; it cannot tell whether the id names a run for a DIFFERENT capability, a run that
// FAILED, or a `post_incident` run being passed off as Stage-3 evidence. `aiEvaluationRunSupportsEdge`
// is the missing half, and it is here rather than in `capability-lifecycle.ts` because it needs the run
// row — which the lifecycle gate has no port to fetch.
import type {
  AiEvaluationRunDecision,
  AiEvaluationRunStage,
  AiEvaluationRunStatus,
  AiLifecycleApprovalKind,
} from "@wardenx/types";

import { aiGovernanceRefusal, type AiGovernanceRefusal } from "../governance/errors";

/** The statuses a run can no longer leave. */
export const AI_EVALUATION_TERMINAL_STATUSES: readonly AiEvaluationRunStatus[] = [
  "passed",
  "failed",
  "aborted",
];

/** True when the run has finished, whatever the outcome. */
export function aiEvaluationRunIsTerminal(status: AiEvaluationRunStatus): boolean {
  return AI_EVALUATION_TERMINAL_STATUSES.includes(status);
}

/**
 * The run's own lifecycle.
 *
 * `pending → aborted` exists (a queued run cancelled before the `ai:evaluations` worker — concurrency
 * 1 per §4.8 — ever picked it up); `in_progress → pending` does not (a re-queue is a NEW run, because
 * the old one's MLflow artifact already exists and reusing the row would make two replays share one
 * `mlflow_run_id`).
 */
export const AI_EVALUATION_RUN_EDGES: readonly {
  readonly from: AiEvaluationRunStatus;
  readonly to: AiEvaluationRunStatus;
}[] = [
  { from: "pending", to: "in_progress" },
  { from: "pending", to: "aborted" },
  { from: "in_progress", to: "passed" },
  { from: "in_progress", to: "failed" },
  { from: "in_progress", to: "aborted" },
];

/** True when the run's lifecycle permits the move. Fails CLOSED on an unknown pair. */
export function canAiEvaluationRunTransition(
  from: AiEvaluationRunStatus,
  to: AiEvaluationRunStatus,
): boolean {
  return AI_EVALUATION_RUN_EDGES.some((e) => e.from === from && e.to === to);
}

/** The `ai_evaluation_run` columns the rules read. */
export interface AiEvaluationRunSnapshot {
  readonly id: string;
  readonly capabilityId: string;
  readonly backendId: string;
  readonly stage: AiEvaluationRunStage;
  readonly status: AiEvaluationRunStatus;
  readonly decision: AiEvaluationRunDecision;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** R26/W6 — what the worker reports when a run moves. */
export interface AiEvaluationRunTransitionRequest {
  readonly toStatus: AiEvaluationRunStatus;
  /** `no_decision` on every non-terminal move; a ruling only on a terminal one. */
  readonly decision: AiEvaluationRunDecision;
  /** The headline metric snapshot (§3.2.11); MLflow stays the record. */
  readonly summaryMetrics: Record<string, unknown> | null;
}

/** The columns an accepted transition writes. */
export interface AiEvaluationRunPatch {
  readonly status: AiEvaluationRunStatus;
  readonly decision: AiEvaluationRunDecision;
  readonly summaryMetrics: Record<string, unknown> | null;
  /** Stamped on the FIRST entry to `in_progress` only — a re-stamp would erase the queue latency the
   *  §4.8 concurrency-1 queue is measured by. */
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export type AiEvaluationRunTransitionDecision =
  | { readonly ok: true; readonly patch: AiEvaluationRunPatch }
  | AiGovernanceRefusal;

/** The two decisions that assert the capability may advance. */
const AI_EVALUATION_APPROVING_DECISIONS: readonly AiEvaluationRunDecision[] = [
  "approve_for_pilot",
  "approve_for_ga",
];

/** W6.3 — move the run and, on a terminal move, record the ruling. */
export function evaluateAiEvaluationRunTransition(
  request: AiEvaluationRunTransitionRequest,
  current: AiEvaluationRunSnapshot,
  at: string,
): AiEvaluationRunTransitionDecision {
  if (!canAiEvaluationRunTransition(current.status, request.toStatus)) {
    return aiGovernanceRefusal(
      "AI_EVALUATION_RUN_INVALID_TRANSITION",
      aiEvaluationRunIsTerminal(current.status)
        ? `evaluation run ${current.id} finished at '${current.status}'; re-running is a NEW run, not a move back to '${request.toStatus}'`
        : `'${current.status}' -> '${request.toStatus}' is not an edge of the evaluation-run lifecycle`,
    );
  }

  const terminal = aiEvaluationRunIsTerminal(request.toStatus);
  if (request.decision !== "no_decision") {
    if (!terminal) {
      return aiGovernanceRefusal(
        "AI_EVALUATION_DECISION_REQUIRES_TERMINAL_STATUS",
        `decision '${request.decision}' cannot be recorded while the run is '${request.toStatus}'`,
      );
    }
    if (
      AI_EVALUATION_APPROVING_DECISIONS.includes(request.decision) &&
      request.toStatus !== "passed"
    ) {
      return aiGovernanceRefusal(
        "AI_EVALUATION_DECISION_REQUIRES_PASS",
        `decision '${request.decision}' asserts the capability may advance, but the run is '${request.toStatus}'`,
      );
    }
  }

  return {
    ok: true,
    patch: {
      status: request.toStatus,
      decision: request.decision,
      summaryMetrics: request.summaryMetrics,
      startedAt: request.toStatus === "in_progress" ? at : current.startedAt,
      completedAt: terminal ? at : current.completedAt,
    },
  };
}

/**
 * D10 — which run stages are evidence for which §2.2 approval kind.
 *
 * `drift_response` and `post_incident` are evidence for NEITHER promotion gate. Both are runs performed
 * on a capability that is already live, to explain something that went wrong; citing one as the Stage-3
 * gate's evidence would let an incident investigation stand in for the evaluation the capability never
 * had. They are evidence for `reapproval`, which is the gate a live capability actually re-passes.
 */
export const AI_EVALUATION_STAGE_FOR_APPROVAL: {
  readonly [K in AiLifecycleApprovalKind]: readonly AiEvaluationRunStage[];
} = {
  stage_1_proposal: [],
  stage_2_design_review: [],
  stage_3_evaluation: ["stage_3_evaluation"],
  stage_4_pilot: ["stage_4_pilot"],
  stage_5_ga: ["stage_4_pilot"],
  reapproval: ["reapproval", "drift_response", "post_incident"],
  deprecation: [],
  retirement: [],
  incident_demotion: [],
};

/**
 * Does this run support the edge citing it (D10)?
 *
 * Three conditions, and each has a failure the presence-only check waves through: the run must be for
 * the SAME capability (a passing run for a different capability is not evidence about this one), it must
 * have `passed` (a `failed` run cited as evidence reads as satisfied D10 to anyone auditing the
 * `linked_evaluation_run_id` column without opening the run), and its `stage` must be evidence for the
 * gate (see `AI_EVALUATION_STAGE_FOR_APPROVAL`).
 */
export function aiEvaluationRunSupportsEdge(
  run: AiEvaluationRunSnapshot,
  capabilityId: string,
  approvalKind: AiLifecycleApprovalKind,
): AiGovernanceRefusal | { readonly ok: true } {
  if (run.capabilityId !== capabilityId) {
    return aiGovernanceRefusal(
      "AI_EVALUATION_RUN_EVIDENCE_INVALID",
      `evaluation run ${run.id} was performed against capability ${run.capabilityId}, not ${capabilityId}`,
    );
  }
  if (run.status !== "passed") {
    return aiGovernanceRefusal(
      "AI_EVALUATION_RUN_EVIDENCE_INVALID",
      `evaluation run ${run.id} is '${run.status}'; only a passed run is evidence for a governance gate`,
    );
  }
  const stages = AI_EVALUATION_STAGE_FOR_APPROVAL[approvalKind];
  if (!stages.includes(run.stage)) {
    return aiGovernanceRefusal(
      "AI_EVALUATION_RUN_EVIDENCE_INVALID",
      stages.length === 0
        ? `approval kind '${approvalKind}' cites no evaluation evidence; run ${run.id} does not belong on it`
        : `evaluation run ${run.id} is a '${run.stage}' run and '${approvalKind}' is evidenced by ${stages.join(", ")}`,
    );
  }
  return { ok: true };
}
