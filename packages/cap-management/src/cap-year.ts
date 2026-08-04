// @wardenx/cap-management — cap-year window math (D1: the cap accounting year is the federal FY,
// Oct 1 – Sep 30, per BBA-2018 §51005(b) / 42 CFR §418.309(b)). Pure date arithmetic on ISO `YYYY-MM-DD`
// strings (no Date.now / timezone — the caller passes the as-of date). A cap year labelled 'FY2026' RUNS
// Oct 1 2025 → Sep 30 2026 (the federal-FY convention: FY2026 ends Sep 30 2026).

const MS_PER_DAY = 86_400_000;

/** Parse an ISO date (`YYYY-MM-DD`) to a UTC-midnight epoch-day integer (timezone-stable). */
function epochDay(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/** `FYxxxx` → the integer year (e.g. 'FY2026' → 2026). Throws on malformed input. */
export function capYearToInt(capYear: string): number {
  const m = /^FY(\d{4})$/.exec(capYear);
  if (!m) throw new Error(`invalid cap year '${capYear}' (expected FYxxxx)`);
  return Number(m[1]);
}

/** The integer year → `FYxxxx`. */
export function intToCapYear(year: number): string {
  return `FY${year}`;
}

/** The window [startsOn, endsOn] for a cap year. FY2026 → Oct 1 2025 .. Sep 30 2026. */
export function capYearWindow(capYear: string): { startsOn: string; endsOn: string } {
  const fy = capYearToInt(capYear);
  return { startsOn: `${fy - 1}-10-01`, endsOn: `${fy}-09-30` };
}

/** The cap year whose Oct 1 – Sep 30 window contains the given ISO date. */
export function capYearForDate(iso: string): string {
  const [y, m] = iso.split("-").map(Number) as [number, number, number];
  // Oct/Nov/Dec belong to the NEXT federal FY (FY label = calendar year + 1); Jan–Sep keep the calendar year.
  return intToCapYear(m >= 10 ? y + 1 : y);
}

/** Inclusive day count between two ISO dates (endsOn − startsOn + 1). A full FY is 365 or 366 days. */
export function inclusiveDays(startsOn: string, endsOn: string): number {
  return epochDay(endsOn) - epochDay(startsOn) + 1;
}

/**
 * The fraction of a cap-year window that has ELAPSED as of `asOf`, clamped to (0, 1]. Used as the linear-
 * extrapolation denominator (D5). Before the window opens → treated as the first day (avoid div-by-zero);
 * after it closes → 1 (the year is fully elapsed, projection == actual).
 */
export function elapsedFraction(
  window: { startsOn: string; endsOn: string },
  asOf: string,
): number {
  const total = inclusiveDays(window.startsOn, window.endsOn);
  const elapsed = epochDay(asOf) - epochDay(window.startsOn) + 1;
  if (elapsed <= 0) return 1 / total; // pre-start: one day's worth, never 0
  if (elapsed >= total) return 1; // post-close: fully elapsed
  return elapsed / total;
}
