// apps/web/src/shell — the in-memory ceremony/wizard draft store (see modules/23-billing-medicare/write-workflow.ts
// for why it is memory only, never browser storage). It lives in the shell so sign-out (the lock screen's sign-out link
// included) and session expiry can forget every draft: a draft can carry PHI and must not outlive the session. An idle
// lock keeps drafts.
import { clearAllLastReviewTasks } from "./last-review-task";
import { clearAllStepUpDrafts } from "./step-up-redirect";

const drafts = new Map<string, unknown>();

/** Stash a ceremony/wizard draft in process memory only. */
export function saveDraft<T>(key: string, value: T): void {
  drafts.set(key, value);
}

/** Recall a draft saved by {@link saveDraft}, or `undefined` if none (or the tab reloaded). */
export function loadDraft<T>(key: string): T | undefined {
  return drafts.get(key) as T | undefined;
}

/** Drop a draft once its ceremony completes, is cancelled, or its wizard finishes. */
export function clearDraft(key: string): void {
  drafts.delete(key);
}

/** Forget every stashed draft (sign-out, session expiry; not an idle lock). */
export function clearAllDrafts(): void {
  drafts.clear();
  clearAllStepUpDrafts(); // the in-memory step-up drafts go with them
  clearAllLastReviewTasks(); // so does the session's "last opened review task" id
}
