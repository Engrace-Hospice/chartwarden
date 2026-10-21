// @chartwarden/billing — M23 pure calendar-date helpers (D6 / D7). The HIPPS day-bucketing (days 1-7 vs
// days 8+ of the hospice stay) and the SIA last-7-days-of-life window are CALENDAR-DAY arithmetic, so
// these helpers operate over ISO `YYYY-MM-DD` strings via UTC epoch-day math — never a local-timezone
// `Date` (a DST or tz offset would shift a day boundary and mis-bill a per-diem). Every function is a
// PURE total function of its arguments and reads NO clock; the "today" comparisons (`service_to <= today`)
// that a real submission needs live in the Phase-3 service layer, never here.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`, no `Date.now()`.
import type { IsoDate } from "../contracts";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Parse + validate a strict `YYYY-MM-DD` (rejecting impossible dates like `2026-02-30`); throws otherwise. */
function parseParts(iso: string): { y: number; m: number; d: number } {
  const match = ISO_DATE_RE.exec(iso);
  if (!match) {
    throw new RangeError(`invalid ISO date '${iso}' (expected YYYY-MM-DD)`);
  }
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  // Round-trip through UTC to reject overflow dates (e.g. 2026-02-30 → March 2).
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    throw new RangeError(`invalid ISO calendar date '${iso}'`);
  }
  return { y, m, d };
}

/** The UTC epoch-day index (days since 1970-01-01) for an ISO date — the canonical comparable integer. */
export function toEpochDay(iso: IsoDate): number {
  const { y, m, d } = parseParts(iso);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/** Inverse of {@link toEpochDay}: render an epoch-day index back to an ISO `YYYY-MM-DD`. */
export function fromEpochDay(day: number): IsoDate {
  if (!Number.isInteger(day)) {
    throw new RangeError(`fromEpochDay: day must be an integer (got ${day})`);
  }
  const dt = new Date(day * MS_PER_DAY);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Add `n` calendar days (may be negative) to an ISO date, returning a new ISO date. */
export function addDaysIso(iso: IsoDate, n: number): IsoDate {
  if (!Number.isInteger(n)) {
    throw new RangeError(`addDaysIso: n must be an integer (got ${n})`);
  }
  return fromEpochDay(toEpochDay(iso) + n);
}

/**
 * The INCLUSIVE day count of the closed interval `[fromIso, toIso]` (a single-day interval is `1`).
 * Throws when `toIso` precedes `fromIso` — an inverted range is a caller bug, not a zero/negative count.
 */
export function inclusiveDayCount(fromIso: IsoDate, toIso: IsoDate): number {
  const from = toEpochDay(fromIso);
  const to = toEpochDay(toIso);
  if (to < from) {
    throw new RangeError(`inclusiveDayCount: 'to' (${toIso}) precedes 'from' (${fromIso})`);
  }
  return to - from + 1;
}

/** True iff `iso` falls within the INCLUSIVE closed interval `[fromIso, toIso]`. */
export function isWithinInclusive(iso: IsoDate, fromIso: IsoDate, toIso: IsoDate): boolean {
  const x = toEpochDay(iso);
  return x >= toEpochDay(fromIso) && x <= toEpochDay(toIso);
}

/** The later of two ISO dates. */
export function maxIso(a: IsoDate, b: IsoDate): IsoDate {
  return toEpochDay(a) >= toEpochDay(b) ? a : b;
}

/** The earlier of two ISO dates. */
export function minIso(a: IsoDate, b: IsoDate): IsoDate {
  return toEpochDay(a) <= toEpochDay(b) ? a : b;
}

/**
 * The 1-based day-of-stay for `serviceDate` measured from `admissionDate` (the hospice election start):
 * the admission date itself is day 1. Drives the HIPPS RHC days-1-7 vs days-8+ payment-period bucket
 * (D7). A `serviceDate` before the admission date yields a value `< 1` (a caller data defect the
 * validation layer surfaces; this helper does not throw on it so the calculator can still bucket it).
 */
export function dayOfStay(admissionDate: IsoDate, serviceDate: IsoDate): number {
  return toEpochDay(serviceDate) - toEpochDay(admissionDate) + 1;
}
