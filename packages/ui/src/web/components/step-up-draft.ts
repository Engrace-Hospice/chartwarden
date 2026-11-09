// @chartwarden/ui — keeps an operator's typed form across the step-up round trip (#597, F-043). A 403
// STEP_UP_REQUIRED sends the operator to /step-up and back; without this the inputs are gone when they return. The draft
// lives in sessionStorage (this tab only) with a short TTL, is restored ONCE on return (read, then removed on mount), and storage
// failures (private mode, quota, blocked) are non-fatal: the operator merely retypes. Platform billing/tenant admin
// data only - never PHI and never a credential.
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { isStepUpReturn } from "./step-up-card";

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

// Free text an operator typed (an evidence note, a reason for the audit trail) is screened by the server for patient identifiers, so it
// may hold one until that screen refuses it: it is never written to sessionStorage. It is kept in this tab's memory only, which the
// step-up round trip (a client-side route) keeps and a reload, a new tab or a sign-out drops.
const memoryDrafts = new Map<string, Stored<unknown>>();

/** Keep `value` for the return from step-up in memory only (never storage): for free text that must not touch the disk. */
export function stashStepUpMemoryDraft<T>(key: string, value: T, now: number = Date.now()): void {
  memoryDrafts.set(key, { savedAt: now, value });
}

/** The in-memory draft, or undefined when absent or expired. Does NOT remove it (see {@link useStepUpMemoryDraft}). */
export function peekStepUpMemoryDraft<T>(key: string, now: number = Date.now()): T | undefined {
  const stored = memoryDrafts.get(key);
  if (!stored || now - stored.savedAt > STEP_UP_DRAFT_TTL_MS) return undefined;
  return stored.value as T;
}

/** {@link useStepUpDraft} for a memory draft: restored once per mount, and only on the step-up return, then dropped. */
export function useStepUpMemoryDraft<T>(key: string, returned?: boolean): T | undefined {
  const fromLocation = isStepUpReturn(useLocation().state);
  const [restored] = useState(() =>
    (returned ?? fromLocation) ? peekStepUpMemoryDraft<T>(key) : undefined,
  );
  useEffect(() => {
    memoryDrafts.delete(key);
  }, [key]);
  return restored;
}

/** Drop every draft this module stashed (sign-out): a draft must not outlive the session that typed it. */
export function discardStepUpDrafts(): void {
  memoryDrafts.clear();
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
 * The draft stashed before a step-up round trip, restored ONCE per mount and only on the return from it (the history state
 * `StepUpCard` navigates back with, or `returned` when a parent already consumed that marker). Leaving for /step-up and
 * pressing Back is an abandoned step-up: the draft is still consumed, so it never reopens a form on a later visit.
 * The read is non-destructive and the removal
 * happens in an effect: a destructive read inside a render-time initializer is run twice by React StrictMode (dev), and
 * the second run would find nothing and silently drop what the operator typed.
 */
export function useStepUpDraft<T>(key: string, returned?: boolean): T | undefined {
  const fromLocation = isStepUpReturn(useLocation().state);
  const [restored] = useState(() =>
    (returned ?? fromLocation) ? peekStepUpDraft<T>(key) : undefined,
  );
  useEffect(() => {
    clearStepUpDraft(key);
  }, [key]);
  return restored;
}
