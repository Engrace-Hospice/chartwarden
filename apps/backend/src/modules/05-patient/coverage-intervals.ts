// apps/backend/src/modules/05-patient/coverage-intervals.ts — the ONE interval convention for `patient_payer` (#845).
//
// `effective_from` and `effective_to` are both INCLUSIVE calendar dates (`effective_to` NULL = open-ended). A
// replacement at an occupied rank therefore closes the prior row on the day BEFORE the replacement starts; closing it
// ON that day (the pre-#845 writer) put two rank-1 coverages in force on the transition date. Migration 1291 enforces
// the same rule in the database (an exclusion constraint per org/patient/rank over `daterange(from, to, '[]')`).
//
// Every date here is an ISO yyyy-mm-dd string; lexicographic order equals calendar order, so no timezone can drift.
import { ChartWardenError, type CoverageForRange, type PatientCoverage } from "@chartwarden/types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** `iso` shifted by `days`; a value that is not a real yyyy-mm-dd date is a typed 422, never a NaN date. */
export function addDaysIso(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!ISO_DATE.test(iso) || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== iso) {
    throw new ChartWardenError("VALIDATION_FAILED", `"${iso}" is not a yyyy-mm-dd date`, 422);
  }
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/** In force on `onDate`, both ends inclusive. A row whose `effectiveTo` precedes its start is never in force. */
export function inForceOn(
  c: Pick<PatientCoverage, "effectiveFrom" | "effectiveTo">,
  onDate: string,
): boolean {
  return c.effectiveFrom <= onDate && (c.effectiveTo === null || c.effectiveTo >= onDate);
}

/**
 * The date the current coverage at a rank closes on when a replacement starting `replacementFrom` is recorded.
 * A replacement starting on or before the current row's own start would invert that row's dates; that is refused
 * rather than voiding the row, because the row may already be stamped on a claim (`patient_payer_id`) and silently
 * erasing its coverage window would rewrite billed history. Correct such an entry explicitly instead.
 */
export function replacementClosesOn(currentFrom: string, replacementFrom: string): string {
  const closeOn = addDaysIso(replacementFrom, -1);
  if (closeOn < currentFrom) {
    throw new ChartWardenError(
      "PAYER_REPLACEMENT_NOT_AFTER_CURRENT",
      `The new coverage must start after the current coverage at this rank (which starts ${currentFrom}). A replacement starting on or before that date would erase the current coverage's history.`,
      409,
    );
  }
  return closeOn;
}

function topRanked(pool: readonly PatientCoverage[], day: string) {
  const inForce = pool.filter((c) => inForceOn(c, day)).sort((a, b) => a.rank - b.rank);
  const [first, second] = inForce;
  if (first === undefined) return "none" as const;
  if (second !== undefined && second.rank === first.rank) return "ambiguous" as const;
  return first;
}

/**
 * The coverage that is top-ranked on EVERY day of the inclusive window, across every kind (or only `coverageKind`).
 * The in-force set only changes on a row's first day or the day after its last, so evaluating `from` plus each such
 * boundary inside the window covers every day without walking them one by one.
 */
export function coverageForRange(
  coverages: readonly PatientCoverage[],
  range: { readonly from: string; readonly to: string },
  coverageKind?: string,
): CoverageForRange {
  addDaysIso(range.from, 0);
  addDaysIso(range.to, 0);
  if (range.to < range.from) {
    throw new ChartWardenError("VALIDATION_FAILED", "the range ends before it starts", 422);
  }
  const pool =
    coverageKind === undefined
      ? coverages
      : coverages.filter((c) => c.coverageKind === coverageKind);
  const inWindow = (d: string) => d > range.from && d <= range.to;
  const boundaries = new Set<string>([range.from]);
  for (const c of pool) {
    if (inWindow(c.effectiveFrom)) boundaries.add(c.effectiveFrom);
    if (c.effectiveTo !== null && c.effectiveTo >= c.effectiveFrom) {
      const after = addDaysIso(c.effectiveTo, 1);
      if (inWindow(after)) boundaries.add(after);
    }
  }
  let first: PatientCoverage | undefined;
  for (const day of [...boundaries].sort()) {
    const top = topRanked(pool, day);
    if (top === "none" || top === "ambiguous") return { status: top, onDate: day };
    if (first === undefined) first = top;
    else if (top.id !== first.id) return { status: "changes", onDate: day };
  }
  // `boundaries` always holds `range.from`, so the loop either returned or set `first`.
  return { status: "uniform", coverage: first as PatientCoverage };
}

/** The two database guards that keep one coverage per rank per day (0020's open-row index, 1291's exclusion). */
const RANK_GUARDS = new Set(["patient_payer_active_rank_unique", "patient_payer_rank_no_overlap"]);

function violatedConstraint(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const { code, constraint, cause } = e as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if ((code === "23505" || code === "23P01") && typeof constraint === "string") return constraint;
  return violatedConstraint(cause);
}

/** Run a payer write; a rank-overlap violation (a concurrent replacement won, or the dates collide with history) is a typed 409. */
export async function payerRankConflictAs409<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const constraint = violatedConstraint(e);
    if (constraint === undefined || !RANK_GUARDS.has(constraint)) throw e;
    throw new ChartWardenError(
      "PAYER_RANK_OVERLAP",
      "Another coverage already occupies this rank on some of these dates (it may have just been recorded by someone else). Reload the coverage list and try again.",
      409,
    );
  }
}
