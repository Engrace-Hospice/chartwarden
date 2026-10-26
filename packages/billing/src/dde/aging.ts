// @chartwarden/billing — age-based status for DDE items that have no filing deadline (ADR-0052 amendment, #767).
// PURE: dates are `YYYY-MM-DD`, no clock. rtp_correction / adjustment / cancel items carry `deadline_at = NULL`: FISS
// holds a returned claim for up to 36 months, so the deadline is not ours to enforce, but an item nobody works still
// costs cash and risks the hold lapsing. Aging is measured in BUSINESS days (Mon-Fri; no holiday calendar: a holiday
// makes an item look one day older, which errs toward earlier attention).
//
// DEFAULTS (product has not specified thresholds; chosen to be defensible, tune here): an open item is at risk after
// 5 business days (one working week) and overdue after 10 (two weeks); an open item still unassigned after 2 business
// days is flagged for the queue manager. There is no per-org config mechanism for the DDE queue, so these are code
// constants.
import { addDaysIso, toEpochDay } from "../domain/dates";
import type { DdeWorkItemState } from "../machines/dde-work-item";

export const DDE_AGING_AT_RISK_BUSINESS_DAYS = 5;
export const DDE_AGING_OVERDUE_BUSINESS_DAYS = 10;
export const DDE_UNASSIGNED_ALERT_BUSINESS_DAYS = 2;

/** Items listed per category in one aging alert payload (ids only; the full list is the queue's overdue filter). */
export const DDE_AGING_ALERT_MAX_IDS = 20;

const OPEN_STATES: ReadonlySet<DdeWorkItemState> = new Set([
  "queued",
  "assigned",
  "in_progress",
  "submitted",
  "returned",
]);

/** 0 = Sunday .. 6 = Saturday (epoch day 0, 1970-01-01, was a Thursday). */
function isWeekday(epochDay: number): boolean {
  const w = (((epochDay + 4) % 7) + 7) % 7;
  return w !== 0 && w !== 6;
}

/** Weekdays in the half-open interval (from, to]. Zero when `to` is not after `from`. */
export function businessDaysBetween(from: string, to: string): number {
  const end = toEpochDay(to);
  let count = 0;
  for (let d = toEpochDay(from) + 1; d <= end; d += 1) if (isWeekday(d)) count += 1;
  return count;
}

/** The latest creation date an item can have and already be `businessDays` or more business days old on `asOf`. */
export function ddeAgingCutoffDate(asOf: string, businessDays: number): string {
  const asOfDay = toEpochDay(asOf);
  let day = asOfDay;
  let seen = 0;
  for (;;) {
    if (isWeekday(day)) seen += 1;
    if (seen >= businessDays) break;
    day -= 1;
  }
  return addDaysIso(asOf, day - 1 - asOfDay);
}

export type DdeAgingStatus = "on_track" | "at_risk" | "overdue";

/** Age status of an open no-deadline item; `null` when it is not open. */
export function ddeAgingStatus(
  state: DdeWorkItemState,
  openedOn: string,
  asOf: string,
): DdeAgingStatus | null {
  if (!OPEN_STATES.has(state)) return null;
  const age = businessDaysBetween(openedOn, asOf);
  if (age >= DDE_AGING_OVERDUE_BUSINESS_DAYS) return "overdue";
  if (age >= DDE_AGING_AT_RISK_BUSINESS_DAYS) return "at_risk";
  return "on_track";
}

export interface DdeAgingFacts {
  readonly id: string;
  readonly state: DdeWorkItemState;
  readonly deadlineAt: string | null;
  readonly openedOn: string;
  readonly assigneeMembershipId: string | null;
}

export interface DdeAgingFindings {
  readonly overdueIds: string[];
  readonly unassignedIds: string[];
}

/** Which open items the aging alert is about: no-deadline items overdue by age, and any item left unassigned too long. */
export function ddeAgingAlertFindings(
  items: readonly DdeAgingFacts[],
  asOf: string,
): DdeAgingFindings {
  const open = items.filter((i) => OPEN_STATES.has(i.state));
  return {
    overdueIds: open
      .filter(
        (i) => i.deadlineAt === null && ddeAgingStatus(i.state, i.openedOn, asOf) === "overdue",
      )
      .map((i) => i.id),
    unassignedIds: open
      .filter(
        (i) =>
          i.assigneeMembershipId === null &&
          businessDaysBetween(i.openedOn, asOf) >= DDE_UNASSIGNED_ALERT_BUSINESS_DAYS,
      )
      .map((i) => i.id),
  };
}
