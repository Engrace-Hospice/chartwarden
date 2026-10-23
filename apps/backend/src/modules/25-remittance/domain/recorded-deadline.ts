// M25 milestone 7a-1 - the RECORDED DEADLINE (hospice ADR/TPE/QIC PRD, milestone 7). PURE.
//
// A due date the user types FROM A NOTICE (an ALJ hearing notice, a Council notice, a court order, a RAC / UPIC
// request letter), with a mandatory source note. Nothing here knows any CMS / OMHA / RAC / UPIC window: the date is
// always the user's, so the screen says "from your notice, not a computed CMS date". The day ends at 23:59:59.999
// in the provider's zone and feeds the SAME T-30/14/7/1 alert boundaries as the tier deadlines. A past date never
// alerts. No weekend / holiday roll-back is applied: the date is the one printed on the notice.
import {
  DEFAULT_DEADLINE_ZONE,
  deadlineAlertBoundary,
  endOfDayInZone,
  parseNoticeDay,
} from "./deadline";

/** Within this many days a recorded deadline reads "due soon" (display only; the alert boundaries are separate). */
export const DUE_SOON_DAYS = 7;

export const RECORDED_DEADLINE_LABEL_MAX = 120;
export const RECORDED_DEADLINE_NOTE_MAX = 500;

export type RecordedDeadlineStatus = "open" | "due_soon" | "past" | "satisfied";

export type RecordedDeadlineRefusal =
  | "LABEL_REQUIRED"
  | "LABEL_TOO_LONG"
  | "DUE_DATE_INVALID"
  | "SOURCE_NOTE_REQUIRED"
  | "SOURCE_NOTE_TOO_LONG";

export interface RecordedDeadlineDerivation {
  readonly dueOn: string;
  readonly zone: string;
  /** The last millisecond of `dueOn` in `zone`. */
  readonly dueAt: Date;
}

/** End of the typed day in the earliest-ending of the provider's zones (the default zone when none is known). */
export function deriveRecordedDeadline(
  dueOn: string,
  zones: readonly string[],
): RecordedDeadlineDerivation {
  const dayMs = parseNoticeDay(dueOn);
  const list = zones.length > 0 ? zones : [DEFAULT_DEADLINE_ZONE];
  const ends = list.map((zone) => ({ zone, dueAt: endOfDayInZone(dayMs, zone) }));
  const first = ends.reduce((a, b) => (b.dueAt.getTime() < a.dueAt.getTime() ? b : a));
  return { dueOn, zone: first.zone, dueAt: first.dueAt };
}

export function isRealDay(day: string): boolean {
  try {
    parseNoticeDay(day);
    return true;
  } catch {
    return false;
  }
}

export function checkRecordedDeadline(input: {
  readonly label: string;
  readonly dueOn: string;
  readonly sourceNote: string;
}): RecordedDeadlineRefusal | null {
  if (input.label.trim() === "") return "LABEL_REQUIRED";
  if (input.label.length > RECORDED_DEADLINE_LABEL_MAX) return "LABEL_TOO_LONG";
  if (!isRealDay(input.dueOn)) return "DUE_DATE_INVALID";
  if (input.sourceNote.trim() === "") return "SOURCE_NOTE_REQUIRED";
  if (input.sourceNote.length > RECORDED_DEADLINE_NOTE_MAX) return "SOURCE_NOTE_TOO_LONG";
  return null;
}

/** The stored facts a deadline's status and alerts derive from (nothing derived is ever stored). */
export interface RecordedDeadlineFacts {
  readonly dueOn: string;
  readonly zone: string;
  readonly satisfiedOn: string | null;
}

const MS_PER_DAY = 86_400_000;

export function recordedDeadlineStatus(
  d: RecordedDeadlineFacts,
  now: Date,
): RecordedDeadlineStatus {
  if (d.satisfiedOn !== null) return "satisfied";
  const dueAt = endOfDayInZone(parseNoticeDay(d.dueOn), d.zone);
  if (now.getTime() > dueAt.getTime()) return "past";
  return Math.ceil((dueAt.getTime() - now.getTime()) / MS_PER_DAY) <= DUE_SOON_DAYS
    ? "due_soon"
    : "open";
}

export interface WatchDeadlineRow extends RecordedDeadlineFacts {
  readonly id: string;
  /** The tightest boundary already alerted for this deadline (null = none yet). */
  readonly lastAlertedBoundary: number | null;
}

/**
 * Which deadlines alert tonight, and at which boundary. One alert per boundary: a boundary at or wider than the last
 * one alerted is skipped, so a nightly cron never repeats itself. Past and satisfied deadlines never alert.
 */
export function selectWatchDue(
  rows: readonly WatchDeadlineRow[],
  now: Date,
): { readonly id: string; readonly boundary: number }[] {
  return rows.flatMap((r) => {
    if (r.satisfiedOn !== null) return [];
    const boundary = deadlineAlertBoundary(endOfDayInZone(parseNoticeDay(r.dueOn), r.zone), now);
    if (boundary === null) return [];
    if (r.lastAlertedBoundary !== null && boundary >= r.lastAlertedBoundary) return [];
    return [{ id: r.id, boundary }];
  });
}
