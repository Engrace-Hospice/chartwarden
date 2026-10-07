// apps/backend/src/modules/06-admission/election-addendum/due-dates.ts — the 42 CFR 418.24(d) addendum clocks
// (FY2027, CMS-1851-F). PURE: calendar arithmetic over org-local dates; no clock, no I/O.
//
//   (d)(1) initial — "within the first 5 days of the effective date of the hospice election"; MLN Connects
//          2026-10-01 reads "5 calendar days of the effective date". Due = effective date + 5 calendar days,
//          inclusive of that whole org-local day (the window closes at 23:59:59.999 org time).
//   (d)(2) update  — "within 3 days" of a plan-of-care change that affects the determinations; MLN: "within 3
//          calendar days of the plan of care change". Due = the change's org-local date + 3 calendar days.
//
// Scope: only elections whose effective date is on or after 2026-10-01 (418.24(b)(6), (c), (d)(1): "for hospice
// elections beginning on or after October 1, 2026"). Earlier elections owe no addendum (it was on-request only).
import type { LocalDate } from "@wardenx/types";
import {
  addCalendarDays,
  endOfOrgDayInstant,
  localDateOfInstant,
} from "../certification/window-math";

/** 418.24(b)(6)/(c)/(d): the first election effective date the mandatory addendum applies to. */
export const ELECTION_ADDENDUM_MANDATORY_FROM: LocalDate = "2026-10-01";

/** 418.24(d)(1): calendar days after the election's effective date to furnish the initial addendum. */
export const INITIAL_ADDENDUM_DAYS = 5;

/** 418.24(d)(2): calendar days after a plan-of-care change to furnish the updated addendum. */
export const UPDATE_ADDENDUM_DAYS = 3;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertLocalDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) throw new Error(`${label} must be yyyy-mm-dd, got '${value}'`);
}

/** True when an election effective on `effectiveDate` owes the mandatory addendum (>= 2026-10-01). */
export function addendumRequiredForElection(
  effectiveDate: LocalDate,
  mandatoryFrom: LocalDate = ELECTION_ADDENDUM_MANDATORY_FROM,
): boolean {
  assertLocalDate(effectiveDate, "effectiveDate");
  return effectiveDate >= mandatoryFrom;
}

/** The initial addendum's due window: last org-local day and the instant that day ends. */
export interface AddendumDue {
  readonly dueDate: LocalDate;
  readonly dueAt: string;
}

/** 418.24(d)(1): due = effective date + 5 calendar days (end of that org-local day). */
export function initialAddendumDue(effectiveDate: LocalDate, timeZone: string): AddendumDue {
  assertLocalDate(effectiveDate, "effectiveDate");
  const dueDate = addCalendarDays(effectiveDate, INITIAL_ADDENDUM_DAYS);
  return { dueDate, dueAt: endOfOrgDayInstant(dueDate, timeZone) };
}

/** 418.24(d)(2): due = the plan-of-care change's org-local date + 3 calendar days (end of that day). */
export function updateAddendumDue(changedAt: string, timeZone: string): AddendumDue {
  const changeDate = localDateOfInstant(changedAt, timeZone);
  const dueDate = addCalendarDays(changeDate, UPDATE_ADDENDUM_DAYS);
  return { dueDate, dueAt: endOfOrgDayInstant(dueDate, timeZone) };
}

/** Whole calendar days from `today` until `dueDate` (negative once overdue) — the UI countdown. */
export function daysUntilDue(dueDate: LocalDate, today: LocalDate): number {
  assertLocalDate(dueDate, "dueDate");
  assertLocalDate(today, "today");
  const ms = Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
