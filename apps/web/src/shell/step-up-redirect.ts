// apps/web/src/shell — the one place a screen turns a server "your session is not fresh enough" refusal
// into the `/step-up?returnTo=` route (02-identity/step-up.tsx), plus a small sessionStorage stash so what
// the user had typed survives the round trip. Only a 403 carrying `STEP_UP_REQUIRED` qualifies: any other
// 403 is a permanent "not allowed", and redirecting it into a ceremony would be a loop with no exit.
// The refusal test and the path are the shared kit's (also used by apps/admin), so both apps agree.
import { isStepUpRequired, stepUpPath } from "@wardenx/ui";

const DRAFT_PREFIX = "wx.step-up-draft:";

/** `/step-up?returnTo=<path>` when `error` is the step-up refusal, else null. */
export function stepUpRedirectFor(error: unknown, returnTo: string): string | null {
  return isStepUpRequired(error) ? stepUpPath(returnTo) : null;
}

/** A draft older than this is dropped unread: the user is not coming back to it. */
const DRAFT_TTL_MS = 15 * 60_000;
const SCOPE_SEP = "|";

interface DraftEnvelope {
  readonly at: number;
  readonly value: unknown;
}

export type StepUpDraftOwner =
  | { readonly userId: string; readonly organizationId: string }
  | null
  | undefined;

/** `org|user|action|resourceId` — a draft is only ever visible to the same org, user, action and record.
 *  Null when there is no session to scope to (nothing is stashed then). */
export function stepUpDraftKey(
  owner: StepUpDraftOwner,
  action: string,
  resourceId: string,
): string | null {
  if (!owner) return null;
  return [owner.organizationId, owner.userId, action, resourceId].join(SCOPE_SEP);
}

function readEnvelope(storageKey: string): DraftEnvelope | null {
  const raw = window.sessionStorage.getItem(storageKey);
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as DraftEnvelope;
  if (typeof parsed?.at !== "number" || Date.now() - parsed.at > DRAFT_TTL_MS) {
    window.sessionStorage.removeItem(storageKey);
    return null;
  }
  return parsed;
}

/** Drop expired drafts and any scoped draft that belongs to a different org/user than `key`'s. */
function sweep(key: string): void {
  const scope = key.split(SCOPE_SEP).slice(0, 2).join(SCOPE_SEP) + SCOPE_SEP;
  const scoped = key.includes(SCOPE_SEP);
  const stale: string[] = [];
  for (let i = 0; i < window.sessionStorage.length; i += 1) {
    const k = window.sessionStorage.key(i);
    if (!k?.startsWith(DRAFT_PREFIX)) continue;
    const rest = k.slice(DRAFT_PREFIX.length);
    const foreign = scoped && rest.includes(SCOPE_SEP) && !rest.startsWith(scope);
    let expired = false;
    try {
      expired = readEnvelope(k) === null;
    } catch {
      expired = true;
    }
    if (foreign || expired) stale.push(k);
  }
  for (const k of stale) window.sessionStorage.removeItem(k);
}

/** Keep `value` (JSON-serialisable) for the return from step-up. Storage failures are non-fatal: the user
 *  merely retypes. Never stash a token or secret — only what the form already holds. */
export function stashStepUpDraft(key: string | null, value: unknown): void {
  if (key === null) return;
  try {
    const envelope: DraftEnvelope = { at: Date.now(), value };
    window.sessionStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(envelope));
  } catch {
    // Private mode / blocked storage: the draft is a convenience, never state of record.
  }
}

/** Read WITHOUT clearing (a render-safe read: StrictMode double-invokes initialisers). Null when absent,
 *  expired, foreign or unreadable. Clear it with `clearStepUpDraft` on submit/cancel. */
export function peekStepUpDraft<T>(key: string | null): T | null {
  if (key === null) return null;
  try {
    sweep(key);
    return (readEnvelope(DRAFT_PREFIX + key)?.value as T | undefined) ?? null;
  } catch {
    return null;
  }
}

export function clearStepUpDraft(key: string | null): void {
  if (key === null) return;
  try {
    window.sessionStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    // Non-fatal.
  }
}

/** The resource id of this user's pending draft for `action`, so a list screen can reopen its modal after
 *  the step-up round trip. Null when there is none. */
export function findStepUpDraftResourceId(owner: StepUpDraftOwner, action: string): string | null {
  const prefix = stepUpDraftKey(owner, action, "");
  if (prefix === null) return null;
  try {
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const k = window.sessionStorage.key(i);
      if (!k?.startsWith(DRAFT_PREFIX + prefix)) continue;
      if (readEnvelope(k) !== null) return k.slice(DRAFT_PREFIX.length + prefix.length);
    }
  } catch {
    // Non-fatal.
  }
  return null;
}

/** Read and clear a stashed draft; null when absent or unreadable. */
export function takeStepUpDraft<T>(key: string): T | null {
  const value = peekStepUpDraft<T>(key);
  clearStepUpDraft(key);
  return value;
}

// A draft alone is not proof the user is coming back: they may have abandoned the step-up. The step-up card
// records a ONE-SHOT, short-lived "verified, returning to <path>" marker; a screen reopens its stashed modal only
// when that marker names its own path, and otherwise discards the stale draft.
const RETURN_KEY = "wx.step-up-returned";
const RETURN_TTL_MS = 2 * 60_000;

/** Called by the step-up page once freshness is recorded, just before it navigates to `returnTo`. */
export function markStepUpReturn(returnTo: string): void {
  try {
    window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({ at: Date.now(), path: returnTo }));
  } catch {
    // Non-fatal: the user simply gets no auto-reopened modal.
  }
}

/** True when a fresh marker names `path`. Does not consume (render-safe); call `clearStepUpReturn` in an effect. */
export function peekStepUpReturn(path: string): boolean {
  try {
    const raw = window.sessionStorage.getItem(RETURN_KEY);
    if (raw === null) return false;
    const m = JSON.parse(raw) as { at?: unknown; path?: unknown };
    return typeof m.at === "number" && Date.now() - m.at <= RETURN_TTL_MS && m.path === path;
  } catch {
    return false;
  }
}

export function clearStepUpReturn(): void {
  try {
    window.sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // Non-fatal.
  }
}

/** Drop every stashed draft of `action` that belongs to this owner (an abandoned step-up). */
export function discardStepUpDrafts(owner: StepUpDraftOwner, action: string): void {
  const MAX_DRAFTS = 20; // a clear that silently fails must not spin forever
  for (let n = 0; n < MAX_DRAFTS; n += 1) {
    const id = findStepUpDraftResourceId(owner, action);
    if (id === null) return;
    clearStepUpDraft(stepUpDraftKey(owner, action, id));
  }
}

/** Forget every stashed step-up draft and the return marker (sign-out, screen lock): a draft can carry free text and must not outlive the session. */
export function clearAllStepUpDrafts(): void {
  try {
    const mine: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const k = window.sessionStorage.key(i);
      if (k?.startsWith(DRAFT_PREFIX)) mine.push(k);
    }
    for (const k of mine) window.sessionStorage.removeItem(k);
  } catch {
    // Non-fatal.
  }
  clearStepUpReturn();
}
