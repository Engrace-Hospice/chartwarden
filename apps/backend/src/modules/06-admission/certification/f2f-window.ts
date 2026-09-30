// apps/backend/src/modules/06-admission/certification/f2f-window.ts — F-226 the pure pieces of "real F2F dates".
//
// PURE: no IO, no `Date.now()`. Three facts the service used to hard-code are now derived here:
//   1. a PENDING period's EXPECTED START = the preceding period's `scheduled_end_at` + 1 calendar day
//      (benefit periods are contiguous — 42 CFR 418.21(a); M6 §2.3.2 `setActive` "previous period
//      .actual_end_at + 1 day"; the F-178b window-missed scan and the M14 recert-window seam derive the same
//      day). Stored on `election_period.expected_start` when the pending shell is opened.
//   2. which start a period's F2F window is anchored to (`resolveF2fWindowStart`).
//   3. whether a supplied encounter date is sane (not future, not absurdly old) before the R-F2F-02 window
//      arithmetic (`state-machines/validation.ts` `checkF2fWindow`) is applied to it.
import type { LocalDate } from "@wardenx/types";
import { AdmissionStateError } from "../state-machines/errors";
import { addCalendarDays } from "./window-math";

/** An encounter dated more than this many days before today is refused outright, override or not. */
export const F2F_MAX_ENCOUNTER_AGE_DAYS = 365;

/** The expected start of the period that follows one scheduled to end on `priorScheduledEnd`; null = unknown. */
export function expectedStartFromPriorEnd(priorScheduledEnd: LocalDate | null): LocalDate | null {
  return priorScheduledEnd ? addCalendarDays(priorScheduledEnd, 1) : null;
}

export type F2fWindowStartSource = "expected_start" | "prior_period_end" | "effective_at";

/**
 * The start the F2F window is computed against, in order of authority:
 *   1. the persisted `expected_start` (stamped at creation);
 *   2. the preceding period's `scheduled_end_at` + 1 (a legacy/un-stamped pending period);
 *   3. the period's own `effective_at` (an already-activated period — its start IS the benefit-period start).
 * `null` = not derivable (the window is unverifiable: callers fail closed).
 * NOTE (pre-existing, reported in F-226): activation stamps `effective_at` = the activation day, which can
 * differ from the expected start; the gate deliberately keeps using the expected start.
 */
export function resolveF2fWindowStart(facts: {
  readonly expectedStart: LocalDate | null;
  readonly priorScheduledEnd: LocalDate | null;
  readonly effectiveAt: LocalDate | null;
}): { start: LocalDate; source: F2fWindowStartSource } | null {
  if (facts.expectedStart) return { start: facts.expectedStart, source: "expected_start" };
  const derived = expectedStartFromPriorEnd(facts.priorScheduledEnd);
  if (derived) return { start: derived, source: "prior_period_end" };
  if (facts.effectiveAt) return { start: facts.effectiveAt, source: "effective_at" };
  return null;
}

/**
 * The encounter date must be a real past-or-present calendar date: not after `today` (org-local) and not
 * more than {@link F2F_MAX_ENCOUNTER_AGE_DAYS} before it. Window membership is a separate rule (R-F2F-02).
 */
export function assertPlausibleEncounterDate(encounterDate: LocalDate, today: LocalDate): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(encounterDate) || Number.isNaN(Date.parse(`${encounterDate}T00:00:00Z`))) {
    throw new AdmissionStateError(
      "F2F_ENCOUNTER_DATE_INVALID",
      "F2F encounter date is not a valid calendar date",
    );
  }
  if (encounterDate > today) {
    throw new AdmissionStateError(
      "F2F_ENCOUNTER_DATE_INVALID",
      "F2F encounter date cannot be in the future",
    );
  }
  if (encounterDate < addCalendarDays(today, -F2F_MAX_ENCOUNTER_AGE_DAYS)) {
    throw new AdmissionStateError(
      "F2F_ENCOUNTER_DATE_INVALID",
      `F2F encounter date is more than ${F2F_MAX_ENCOUNTER_AGE_DAYS} days in the past`,
    );
  }
}
