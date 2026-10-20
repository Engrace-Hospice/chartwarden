// apps/web/src/shell — the in-memory ceremony/wizard draft store (see modules/23-billing-medicare/write-workflow.ts
// for why it is memory only, never browser storage). It lives in the shell so sign-out and the idle screen lock can
// forget every draft: a draft can carry PHI and must not outlive the session.
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

/** Forget every stashed draft (sign-out, screen lock). */
export function clearAllDrafts(): void {
  drafts.clear();
  clearAllStepUpDrafts(); // the sessionStorage step-up stash goes with them
}
