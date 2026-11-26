// apps/web/src/shell — which review task a reviewer last opened for one intake batch, kept for this browser
// session only (sessionStorage) so a reload lands where they were. Only the opaque task id is stored
// (`candidate:<uuid>`, `identity:<page>`): never a field value, name or page text, and the guard below
// refuses every other shape. It lives in the shell so sign-out (the lock screen's sign-out link included)
// and session expiry forget it with every other draft (`clearAllDrafts`); an idle lock keeps it. A missing,
// blocked or malformed entry is "nothing remembered" and the caller falls back to its default task.
export const LAST_REVIEW_TASK_KEY_PREFIX = "wx.unified-review-task:";
const OPAQUE_TASK_ID =
  /^(?:candidate:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|identity:\d{1,5})$/i;

function storageKey(batchId: string): string {
  return `${LAST_REVIEW_TASK_KEY_PREFIX}${batchId}`;
}

export function rememberLastReviewTask(batchId: string, taskId: string): void {
  if (!OPAQUE_TASK_ID.test(taskId)) return;
  try {
    window.sessionStorage.setItem(storageKey(batchId), taskId);
  } catch {
    // Private mode / blocked storage: the next load simply opens the default task.
  }
}

export function recallLastReviewTask(batchId: string): string | null {
  try {
    const stored = window.sessionStorage.getItem(storageKey(batchId));
    return stored !== null && OPAQUE_TASK_ID.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function forgetLastReviewTask(batchId: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(batchId));
  } catch {
    // Blocked storage: nothing was stored.
  }
}

/** Forget every batch's remembered task (sign-out, session expiry). */
export function clearAllLastReviewTasks(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(LAST_REVIEW_TASK_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) window.sessionStorage.removeItem(key);
  } catch {
    // Blocked storage: nothing was stored.
  }
}
