import { forgetLastReviewTask, rememberLastReviewTask } from "../../../shell/last-review-task";
// Which review task to reopen after a reload (the storage itself is `shell/last-review-task`, which
// sign-out and the idle lock clear). The Part 2 / SUD safeguard is never remembered, because its id
// alone would reveal that this batch has Part 2 content: opening it forgets the earlier task and a
// reload falls back to the default task.
import type { Workspace } from "../doclens-api";
import { identityNeedsAnswer } from "../doclens-model";
import {
  type ReviewTaskTarget,
  SUD_TASK_ID,
  candidateTaskId,
  identityTaskId,
} from "./review-exception-tasks";
import { candidateIsSelectable } from "./review-projection";

/** Remember `taskId` as the one last opened; a task that must not persist forgets the previous one. */
export function rememberOpenedTask(batchId: string, taskId: string | null): void {
  if (taskId === null || taskId === SUD_TASK_ID) forgetLastReviewTask(batchId);
  else rememberLastReviewTask(batchId, taskId);
}

/**
 * Where a remembered task id leads in the current workspace, or null when that task no longer exists
 * (withheld, resolved, excluded) so the caller falls back to its default task.
 */
export function restoreTaskTarget(taskId: string, workspace: Workspace): ReviewTaskTarget | null {
  const candidate = workspace.candidates.find((item) => candidateTaskId(item.id) === taskId);
  if (candidate)
    return candidateIsSelectable(workspace, candidate)
      ? { kind: "candidate", candidateId: candidate.id }
      : null;
  const document = workspace.documents.find(
    (item) => identityNeedsAnswer(item) && identityTaskId(item.pageFrom) === taskId,
  );
  return document
    ? {
        kind: "safeguard",
        page: document.pageFrom,
        focus: { kind: "identity", page: document.pageFrom },
      }
    : null;
}
