// apps/web/src/modules/17-scheduling — what a caller (the visit-note composer's "Schedule next visit") can ask the New Visit form to start
// with, through the URL: a visit purpose and a day. Both are suggestions the scheduler edits; the server still decides eligibility.
// The URL carries no name or MRN, but it does carry the patient id (as the existing `?patient=` links do) together with the visit
// purpose and the day. Those reach browser history and server access logs, and tie the patient id to an intended visit type and date.
// Nothing else about the patient is put in it.
import { toLocalInput } from "@chartwarden/ui";
import type { VisitPurpose } from "./scheduling-api";
import { PURPOSES } from "./scheduling-status";

export interface NewVisitPrefill {
  readonly purpose: VisitPurpose | null;
  readonly date: string | null;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` that names a real calendar day (so `2026-02-30` is refused rather than rolled into March). */
function isRealDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function newVisitPrefillFromParams(params: URLSearchParams): NewVisitPrefill {
  const purpose = params.get("newVisitPurpose") ?? "";
  const date = params.get("newVisitDate") ?? "";
  return {
    // PURPOSES is keyed by every purpose the scheduler accepts (scheduling-status.test pins it to the M17 table).
    purpose: Object.hasOwn(PURPOSES, purpose) ? (purpose as VisitPurpose) : null,
    date: isRealDay(date) ? date : null,
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A `datetime-local` start and end moved to `date` together: whole days are added to both, so the time of day and the length of the
 * visit stay and a window that crosses midnight still ends after it starts. A start that is not a local date-time is returned as it was.
 */
export function moveWindowToDay(
  window: { readonly start: string; readonly end: string },
  date: string,
): { readonly start: string; readonly end: string } {
  const from = /^(\d{4})-(\d{2})-(\d{2})T/.exec(window.start);
  const to = DAY.exec(date);
  if (!from || !to) return window;
  const days = Math.round(
    (Date.UTC(Number(to[1]), Number(to[2]) - 1, Number(to[3])) -
      Date.UTC(Number(from[1]), Number(from[2]) - 1, Number(from[3]))) /
      MS_PER_DAY,
  );
  const shift = (local: string): string => {
    const moved = new Date(local);
    if (Number.isNaN(moved.getTime())) return local;
    moved.setDate(moved.getDate() + days);
    return toLocalInput(moved);
  };
  return { start: shift(window.start), end: shift(window.end) };
}
