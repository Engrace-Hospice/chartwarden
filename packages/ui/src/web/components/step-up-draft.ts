// @chartwarden/ui — keeps an operator's typed form across the step-up round trip (#597, F-043). A 403
// STEP_UP_REQUIRED sends the operator to /step-up and back; without this the inputs are gone when they return. The draft
// lives in sessionStorage (this tab only) with a short TTL, is restored ONCE on return (read, then removed on mount), and storage
// failures (private mode, quota, blocked) are non-fatal: the operator merely retypes. Platform billing/tenant admin
// data only - never PHI and never a credential.
import { useEffect, useState } from "react";

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

/** The saved form, or undefined when absent, expired or unreadable. Does NOT remove it (see {@link useStepUpDraft}). */
export function peekStepUpDraft<T>(key: string, now: number = Date.now()): T | undefined {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (raw === null) return undefined;
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

/** Drop one draft. */
export function clearStepUpDraft(key: string): void {
  try {
    window.sessionStorage.removeItem(PREFIX + key);
  } catch {
    // Non-fatal.
  }
}

/** Drop every draft this module stashed (sign-out): a draft must not outlive the session that typed it. */
export function discardStepUpDrafts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) window.sessionStorage.removeItem(k);
  } catch {
    // Non-fatal.
  }
}

/**
 * The draft stashed before a step-up round trip, restored ONCE per mount. The read is non-destructive and the removal
 * happens in an effect: a destructive read inside a render-time initializer is run twice by React StrictMode (dev), and
 * the second run would find nothing and silently drop what the operator typed.
 */
export function useStepUpDraft<T>(key: string): T | undefined {
  const [restored] = useState(() => peekStepUpDraft<T>(key));
  useEffect(() => {
    clearStepUpDraft(key);
  }, [key]);
  return restored;
}
