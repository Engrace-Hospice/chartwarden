// @chartwarden/billing — DDE work-item deadline status (ADR-0052 D5). PURE: dates are `YYYY-MM-DD` strings.
//
// An NOE/NOTR item's deadline is the notice's `window_target_at`. The deadline is MET only when a MAC acceptance
// date on or before it is recorded: a `submitted` item with no acceptance date is still AT RISK (keying it is not
// enough), and an open item past the deadline is OVERDUE. An accepted item whose recorded MAC date is after the
// deadline MISSED it. Our own submission time never counts.
import { toEpochDay } from "../domain/dates";
import type { DdeWorkItemState } from "../machines/dde-work-item";

/** An open item this many days (or fewer) from its deadline is at risk even before it is submitted. */
export const DDE_AT_RISK_DAYS = 2;

/** The NOE/NOTR watchdog queues work for a notice whose filing window target is this many days away or nearer. */
export const DDE_WATCHDOG_LOOKAHEAD_DAYS = 3;

export type DdeDeadlineStatus = "none" | "on_track" | "at_risk" | "overdue" | "met" | "missed";

export interface DdeDeadlineFacts {
  readonly state: DdeWorkItemState;
  readonly deadlineAt: string | null;
  readonly macAcceptedOn: string | null;
}

const OPEN: ReadonlySet<DdeWorkItemState> = new Set([
  "queued",
  "assigned",
  "in_progress",
  "submitted",
  "returned",
]);

/** Classify an item against its deadline as of `asOf` (`YYYY-MM-DD`). */
export function ddeDeadlineStatus(item: DdeDeadlineFacts, asOf: string): DdeDeadlineStatus {
  if (item.deadlineAt === null) return "none";
  const deadline = toEpochDay(item.deadlineAt);
  if (item.macAcceptedOn !== null && (item.state === "accepted" || item.state === "closed")) {
    return toEpochDay(item.macAcceptedOn) <= deadline ? "met" : "missed";
  }
  if (!OPEN.has(item.state)) return "none";
  const daysLeft = deadline - toEpochDay(asOf);
  if (daysLeft < 0) return "overdue";
  if (item.state === "submitted" || daysLeft <= DDE_AT_RISK_DAYS) return "at_risk";
  return "on_track";
}

/** True for a real calendar date written `YYYY-MM-DD` (2026-02-31 is not one). */
export function isRealCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // Postgres has no year 0 (and a JS Date maps 0000 to 1900-ish ranges): require year >= 1.
  if (Number(value.slice(0, 4)) < 1) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
