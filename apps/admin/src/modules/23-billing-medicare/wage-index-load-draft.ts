// apps/admin/src/modules/23-billing-medicare — keeps the operator's wage-index load form across the step-up round
// trip. A 403 STEP_UP_REQUIRED sends the operator to /step-up and back; without this the pasted CMS table (thousands of
// rows), the fiscal year and the source reference would be gone when they return. sessionStorage (this tab only), a
// short TTL, cleared after a successful load. The draft is platform reference data (CCN → wage index), never PHI, and
// never a credential. Storage failures (private mode, quota, blocked) are non-fatal: the operator merely re-pastes.

const DRAFT_KEY = "wx.admin.wage-index-load-draft";
/** A draft older than this is dropped unread: the operator is not coming back to it. */
export const WAGE_INDEX_DRAFT_TTL_MS = 15 * 60_000;

export interface WageIndexLoadDraft {
  readonly fiscalYearStarting: number;
  readonly sourceReference: string;
  readonly table: string;
}

interface StoredDraft extends WageIndexLoadDraft {
  readonly savedAt: number;
}

function isStoredDraft(value: unknown): value is StoredDraft {
  const v = value as Partial<StoredDraft> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.savedAt === "number" &&
    Number.isInteger(v.fiscalYearStarting) &&
    typeof v.sourceReference === "string" &&
    typeof v.table === "string"
  );
}

/** Keep the form for the return from step-up. */
export function saveWageIndexDraft(draft: WageIndexLoadDraft, now: number = Date.now()): void {
  try {
    const stored: StoredDraft = { ...draft, savedAt: now };
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(stored));
  } catch {
    // Blocked or full storage: the draft is a convenience, never state of record.
  }
}

/** The saved form, or null when absent, expired or unreadable (an expired or malformed draft is removed). */
export function readWageIndexDraft(now: number = Date.now()): WageIndexLoadDraft | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredDraft(parsed) || now - parsed.savedAt > WAGE_INDEX_DRAFT_TTL_MS) {
      window.sessionStorage.removeItem(DRAFT_KEY);
      return null;
    }
    return {
      fiscalYearStarting: parsed.fiscalYearStarting,
      sourceReference: parsed.sourceReference,
      table: parsed.table,
    };
  } catch {
    return null;
  }
}

export function clearWageIndexDraft(): void {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Non-fatal.
  }
}
