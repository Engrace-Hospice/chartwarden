import type { Workspace } from "../doclens-api";
import { identityNeedsAnswer } from "../doclens-model";
import { candidateIsOtherPatient } from "./review-projection";

export interface ReviewGate {
  /** The review is finished: nothing more can be decided or released. */
  readonly complete: boolean;
  /** This reviewer owns the review that is in progress. */
  readonly reviewMine: boolean;
  readonly blocked: boolean;
  /** Why completion is blocked, in the order a reviewer should clear it; null when it is not. */
  readonly blockedReason: string | null;
}

interface Progress {
  readonly decidedCount: number;
  readonly candidateCount: number;
}

function identityBlocksCompletion(workspace: Workspace): boolean {
  const { identityStatus } = workspace.batch;
  const hasTarget = Boolean(workspace.batch.patientId || workspace.batch.referralId);
  const notChecked = hasTarget && (identityStatus === null || identityStatus === "no_target");
  return (
    notChecked ||
    identityStatus === "possible" ||
    identityStatus === "mismatch" ||
    workspace.documents.some(identityNeedsAnswer)
  );
}

function blockedReasonFor(
  workspace: Workspace,
  progress: Progress,
  identityBlocked: boolean,
): string | null {
  if (progress.decidedCount < progress.candidateCount)
    return `${progress.candidateCount - progress.decidedCount} observation(s) still need a decision.`;
  if (workspace.sud.status === "detected")
    return "Resolve the Part 2 / SUD safeguard before completing the review.";
  if (identityBlocked)
    return "Resolve every patient identity safeguard before completing the review.";
  return null;
}

/** What the header may offer: the lifecycle state and, if completion is blocked, the first reason why. */
export function reviewGate(workspace: Workspace, progress: Progress): ReviewGate {
  const blockedReason = blockedReasonFor(workspace, progress, identityBlocksCompletion(workspace));
  return {
    complete:
      workspace.review?.status === "complete" || workspace.batch.status === "writeback_complete",
    reviewMine: workspace.review?.status === "in_progress" && workspace.review.isMine,
    blocked: blockedReason !== null,
    blockedReason,
  };
}

/** The workspace the completion dialog summarises: another patient's observations are not part of it. */
export function completionWorkspace(workspace: Workspace): Workspace {
  return {
    ...workspace,
    candidates: workspace.candidates.filter(
      (candidate) => !candidateIsOtherPatient(workspace, candidate),
    ),
  };
}
