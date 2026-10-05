// apps/web/src/shell — the one place a screen turns a server "your session is not fresh enough" refusal
// into the `/step-up?returnTo=` route (02-identity/step-up.tsx), plus a small sessionStorage stash so what
// the user had typed survives the round trip. Only a 403 carrying `STEP_UP_REQUIRED` qualifies: any other
// 403 is a permanent "not allowed", and redirecting it into a ceremony would be a loop with no exit.
const STEP_UP_CODE = "STEP_UP_REQUIRED";
const DRAFT_PREFIX = "wx.step-up-draft:";

type ErrorBody = { code?: string; status?: number; error?: { code?: string } } | null | undefined;

/** `/step-up?returnTo=<path>` when `error` is the step-up refusal, else null. */
export function stepUpRedirectFor(error: unknown, returnTo: string): string | null {
  const body = error as ErrorBody;
  const code = body?.code ?? body?.error?.code;
  if (code !== STEP_UP_CODE) return null;
  return `/step-up?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Keep `value` (JSON-serialisable) for the return from step-up. Storage failures are non-fatal: the user
 *  merely retypes. */
export function stashStepUpDraft(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(value));
  } catch {
    // Private mode / blocked storage: the draft is a convenience, never state of record.
  }
}

/** Read and clear a stashed draft; null when absent or unreadable. */
export function takeStepUpDraft<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_PREFIX + key);
    if (raw === null) return null;
    window.sessionStorage.removeItem(DRAFT_PREFIX + key);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
