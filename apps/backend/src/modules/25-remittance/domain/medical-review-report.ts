// M25 milestone 9a-2 - the leadership medical-review report. PURE (no I/O): window validation, rates, medians and
// period-over-period change. FIGURES, NOT JUDGMENTS: nothing here is a target, a benchmark, a threshold or a "compliant"
// verdict, and no rule about what CMS or a MAC requires is encoded. Every deadline-based figure the service builds is
// "against the due date on the case"; whether that date came from a verified rule is reported beside it, never assumed.
import { isRealDay } from "./recorded-deadline";

/** Longest window one read may cover. A query bound for a live aggregate (366 days = a leap year), not a rule. */
export const REPORT_MAX_RANGE_DAYS = 366;
/** Reasons listed in each "by reason" table; the rest are reported as a count. A display bound, not a rule. */
export const REPORT_TOP_REASONS = 10;
/** The MAC reason field value counted as a separate "as typed" figure (a label only; it implies no rule). */
export const NON_RESPONSE_MAC_REASON_CODE = "56900";

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type ReportWindowRefusal =
  | "INVALID_DAY"
  | "FROM_AFTER_TO"
  | "TO_IN_FUTURE"
  | "RANGE_TOO_LONG";

export interface ReportWindow {
  readonly from: string;
  readonly to: string;
  readonly days: number;
  /** The equal-length period that ends the day before `from`. */
  readonly previous: { readonly from: string; readonly to: string };
  /** UTC instants: `startsAt` inclusive, `endsBefore` exclusive (the day after `to`). */
  readonly startsAt: string;
  readonly endsBefore: string;
  readonly previousStartsAt: string;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

/** Whole UTC days only: sub-day input cannot isolate a few cases, and `to` may not be in the future. */
export function resolveReportWindow(
  input: { readonly from: string; readonly to: string },
  now: Date,
):
  | { readonly ok: true; readonly window: ReportWindow }
  | { readonly ok: false; readonly reason: ReportWindowRefusal } {
  if (
    !DAY.test(input.from) ||
    !DAY.test(input.to) ||
    !isRealDay(input.from) ||
    !isRealDay(input.to)
  ) {
    return { ok: false, reason: "INVALID_DAY" };
  }
  if (input.from > input.to) return { ok: false, reason: "FROM_AFTER_TO" };
  if (input.to > dayOf(now.getTime())) return { ok: false, reason: "TO_IN_FUTURE" };
  const start = startOfDay(input.from);
  const days = Math.round((startOfDay(input.to) - start) / DAY_MS) + 1;
  if (days > REPORT_MAX_RANGE_DAYS) return { ok: false, reason: "RANGE_TOO_LONG" };
  const previousStart = start - days * DAY_MS;
  return {
    ok: true,
    window: {
      from: input.from,
      to: input.to,
      days,
      previous: { from: dayOf(previousStart), to: dayOf(start - DAY_MS) },
      startsAt: new Date(start).toISOString(),
      endsBefore: new Date(start + days * DAY_MS).toISOString(),
      previousStartsAt: new Date(previousStart).toISOString(),
    },
  };
}

/** numerator / denominator, or null when there is nothing to divide by (never 0 or NaN). */
export function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface PeriodFigure {
  readonly value: number | null;
  readonly previous: number | null;
  /** value - previous on the same scale; null unless both periods have data. */
  readonly change: number | null;
}

export function comparePeriods(value: number | null, previous: number | null): PeriodFigure {
  return { value, previous, change: value === null || previous === null ? null : value - previous };
}

export interface RankedRow {
  readonly key: string;
  readonly count: number;
  readonly dollars: number;
}

/** Highest count first, then dollars, then key (stable). `omitted` counts the rows not shown. */
export function topN<T extends RankedRow>(
  rows: readonly T[],
  limit: number,
): { readonly shown: T[]; readonly omitted: number } {
  const sorted = [...rows].sort(
    (a, b) => b.count - a.count || b.dollars - a.dollars || (a.key < b.key ? -1 : 1),
  );
  return { shown: sorted.slice(0, limit), omitted: Math.max(0, sorted.length - limit) };
}
