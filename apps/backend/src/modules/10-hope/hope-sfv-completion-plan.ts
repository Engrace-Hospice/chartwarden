// apps/backend/src/modules/10-hope/hope-sfv-completion-plan.ts — the regulatory (J2052/J2053) answers a
// completed RFA-04 SFV writes onto its triggering assessment, as a PURE plan. A leaf (no DB, no routes) so
// the Drizzle backend, the in-memory twin and the readiness service all share one definition of "complete
// J2053 content": the plan is `null` exactly when the content is missing or incomplete, and a completion
// is refused on `null` rather than closing the SFV with nothing J2053 behind it.

/** The eight J2053 follow-up items (A-H); every one must carry a value for a completion to be complete. */
export const HOPE_J2053_ITEM_CODES = [
  "J2053A",
  "J2053B",
  "J2053C",
  "J2053D",
  "J2053E",
  "J2053F",
  "J2053G",
  "J2053H",
] as const;

export interface CompletedSfvRegulatoryAnswerPlan {
  readonly answered: ReadonlyMap<string, string>;
  readonly skipped: ReadonlySet<string>;
}

export function buildCompletedSfvRegulatoryAnswerPlan(
  completedDate: string,
  sfvData: Record<string, unknown>,
): CompletedSfvRegulatoryAnswerPlan | null {
  const sectionJ =
    sfvData.J && typeof sfvData.J === "object" && !Array.isArray(sfvData.J)
      ? (sfvData.J as Record<string, unknown>)
      : null;
  const j2053 =
    sectionJ?.J2053 && typeof sectionJ.J2053 === "object" && !Array.isArray(sectionJ.J2053)
      ? (sectionJ.J2053 as Record<string, unknown>)
      : null;

  if (!j2053) return null;

  const answered = new Map<string, string>([
    ["J2052A", "1"],
    ["J2052B", completedDate],
  ]);

  for (const itemCode of HOPE_J2053_ITEM_CODES) {
    const value = j2053[itemCode];
    if (typeof value === "string" && value.trim() !== "") {
      answered.set(itemCode, value);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      answered.set(itemCode, String(value));
    } else {
      return null;
    }
  }

  return {
    answered,
    skipped: new Set(["J2052C"]),
  };
}

/** The PHI-free refusal text shared by both backends (no content echoed, only item names). */
export const SFV_COMPLETION_INCOMPLETE_MESSAGE =
  "An SFV completion needs the follow-up (J2053A-J2053H) content; none was closed and nothing was written.";

/**
 * The key under which the server records, in a completed RFA-04's `data`, facts the CLIENT does not control. It is
 * written by `recordSfv` over whatever the client sent for that key, and read back only for a signed RFA-04. The
 * validators read named sections of `data` and ignore other keys, and the view never returns `data`.
 */
export const SFV_SERVER_RECORD_KEY = "_server";

/** `data` plus the calendar date the completion was written for (J2052B as the clinician wrote it, in their own offset). */
export const withSfvCompletedDate = (
  data: Record<string, unknown>,
  completedDate: string,
): Record<string, unknown> => ({ ...data, [SFV_SERVER_RECORD_KEY]: { completedDate } });

/** The as-written completion date `recordSfv` stored, or `null` for a completion recorded before it did. */
export function serverRecordedCompletedDate(data: Record<string, unknown>): string | null {
  const record = data[SFV_SERVER_RECORD_KEY];
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const date = (record as Record<string, unknown>).completedDate;
  return typeof date === "string" ? date : null;
}
