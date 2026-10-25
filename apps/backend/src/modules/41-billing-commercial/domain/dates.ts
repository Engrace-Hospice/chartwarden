// apps/backend/src/modules/41-billing-commercial/domain/dates.ts — PURE ISO calendar-date (yyyy-mm-dd) helpers. UTC math
// only, so a daylight-saving shift can never move a service day.
const MS_PER_DAY = 86_400_000;

const toMs = (iso: string): number =>
  Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

export const addDays = (iso: string, n: number): string =>
  new Date(toMs(iso) + n * MS_PER_DAY).toISOString().slice(0, 10);

/** Inclusive day count of `[from, to]`; 0 when `to` precedes `from`. */
export const daysInclusive = (from: string, to: string): number =>
  to < from ? 0 : Math.round((toMs(to) - toMs(from)) / MS_PER_DAY) + 1;

export const minDate = (a: string, b: string): string => (a <= b ? a : b);
export const maxDate = (a: string, b: string): string => (a >= b ? a : b);

/** Every ISO day of `[from, to]`. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Collapse a sorted list of ISO days into inclusive `{from, to}` ranges of consecutive days. */
export function toRanges(days: readonly string[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const day of days) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === day) out[out.length - 1] = { from: last.from, to: day };
    else out.push({ from: day, to: day });
  }
  return out;
}
