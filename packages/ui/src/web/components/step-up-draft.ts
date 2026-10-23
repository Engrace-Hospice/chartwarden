// apps/admin/src/shell — keeps an operator's typed form across the step-up round trip (#597, F-043). A 403
// STEP_UP_REQUIRED sends the operator to /step-up and back; without this the inputs are gone when they return. The draft
// lives in sessionStorage (this tab only) with a short TTL, is TAKEN ONCE on return (read + removed), and storage
// failures (private mode, quota, blocked) are non-fatal: the operator merely retypes. Platform billing/tenant admin
// data only - never PHI and never a credential.
const PREFIX = "wx.admin.step-up-draft:";
/** A draft older than this is dropped unread: the operator is not coming back to it. */
export const STEP_UP_DRAFT_TTL_MS = 15 * 60_000;

interface Stored<T> {
  readonly savedAt: number;
  readonly value: T;
}

/** Keep `value` for the return from step-up. */
export function stashStepUpDraft<T>(key: string, value: T, now: number = Date.now()): void {
  try {
    const stored: Stored<T> = { savedAt: now, value };
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify(stored));
  } catch {
    // Blocked or full storage: the draft is a convenience, never state of record.
  }
}

/** The saved form, or undefined when absent, expired or unreadable. Removes it either way. */
export function takeStepUpDraft<T>(key: string, now: number = Date.now()): T | undefined {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (raw === null) return undefined;
    window.sessionStorage.removeItem(PREFIX + key);
    const parsed = JSON.parse(raw) as Partial<Stored<T>> | null;
    if (
      !parsed ||
      typeof parsed.savedAt !== "number" ||
      now - parsed.savedAt > STEP_UP_DRAFT_TTL_MS
    )
      return undefined;
    return parsed.value;
  } catch {
    return undefined;
  }
}
