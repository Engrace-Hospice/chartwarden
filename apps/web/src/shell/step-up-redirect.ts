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

type DraftOwner = { readonly userId: string; readonly organizationId: string } | null | undefined;

/** `org|user|action|resourceId` — a draft is only ever visible to the same org, user, action and record.
 *  Null when there is no session to scope to (nothing is stashed then). */
export function stepUpDraftKey(
  owner: DraftOwner,
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
export function findStepUpDraftResourceId(owner: DraftOwner, action: string): string | null {
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
