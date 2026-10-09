// @wardenx/billing — DDE work-item deadline status (ADR-0052 D5). PURE: dates are `YYYY-MM-DD` strings.
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
