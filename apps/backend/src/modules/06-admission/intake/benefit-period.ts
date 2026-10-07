// apps/backend/src/modules/06-admission/intake/benefit-period.ts — the benefit-period number a NEW admission
// elects into, and the per-period requirements that follow from it. PURE: no IO, no clock (callers pass
// `today` / the planned start date).
//
// WHY A NEW ADMISSION IS NOT ALWAYS "PERIOD 1"
//   • Benefit periods are 90, 90, then an unlimited number of 60 days, "available in the order listed"
//     (42 CFR 418.21). A live discharge or a revocation ENDS the current period and its remaining days are
//     forfeited (Medicare Benefit Policy Manual ch. 9 §20.2.2 / §20.2.3). A later re-election is into "any other
//     election period still available" (42 CFR 418.24, 418.28(c)(3)) — there is no waiting period and the count
//     never restarts. So a patient discharged in period 1 comes back in period 2.
//   • The count is per BENEFICIARY across every hospice (Claims Processing Manual ch. 11 §20.1.6), so the number
//     must be confirmed by staff against the CMS eligibility systems (HETS / ELGA / ELGH). Our own history is only
//     a suggestion — it cannot see a stay at another hospice. That applies to ANY new admission, not only to a
//     readmission to us.
//   • A transfer (patient status 50/51 + the receiving hospice's 8xC) does NOT change the period; a move out of
//     the service area without a transfer (condition code 52) is a live discharge and ends it.
//
// WHAT FOLLOWS FROM THE NUMBER (everything here keys off the chosen sequence, never "1")
//   • length: 90 days for periods 1 and 2, 60 days from period 3 (418.21(a));
//   • certification: period 1 → the hospice physician AND the attending (if the patient has one); period 2+ → the
//     hospice medical director / IDG physician only (418.22(c)). CMS retracted its 2024 "certify every re-election
//     as an initial certification" guidance on 2024-06-06;
//   • face-to-face: required entering period 3 or later — by a hospice physician or hospice-employed NP, within 30
//     calendar days before the period start, the period's first day included (418.22(a)(4); MBPM ch. 9
//     §20.1(5)(a): "may occur on the first day of the benefit period and still be considered timely"). For a NEW admission in period 3+ with documented
//     exceptional circumstances (a weekend emergency admission, CMS systems down so the period was unknown) an
//     encounter within 2 days after admission is timely, and a patient who dies within those 2 days has the F2F
//     deemed complete (MBPM ch. 9 §20.1(5)(d)). §20.1 applies these "to individuals who had been previously
//     discharged during a benefit period" too;
//   • the readmission repeats the whole admission: a new signed election statement (418.24), a new NOE (8xA)
//     within 5 calendar days AFTER the admission date (the day after admission is day 1 — Claims Processing
//     Manual ch. 11 §20.1.1: admitted Fri 10/10, "Day 5 = Weds. 10/15 is the NOE Due Date"), the initial (48 h, 418.54(a)) and comprehensive ("no later than
//     5 calendar days after the election", 418.54(b) — SOM App. M L523 counts the election date as day 0, so elected
//     Wed ⇒ due Mon = election + 5) assessments, and a new HOPE Admission record (A0220 = the re-election date).
//   • two-tier RHC: readmitted within 60 days of a discharge, the prior hospice days carry over for the day 1–60
//     high rate; after a longer gap the day count resets (Claims Processing Manual ch. 11, two-tier RHC).
import {
  RHC_CARRY_OVER_MAX_GAP_DAYS,
  RHC_HIGH_TIER_LAST_DAY,
  clipToBeforeElection,
  isoDateToEpochDay,
  mergeCarryBlocks,
  walkCarryChain,
} from "@wardenx/shared/rhc";
import type { LocalDate } from "@wardenx/types";
import {
  COMPREHENSIVE_ASSESSMENT_DAYS,
  INITIAL_ASSESSMENT_DAYS,
  addCalendarDays,
  comprehensiveAssessmentDueOn,
} from "../certification/window-math";
import {
  ELECTION_PERIOD_LENGTH_DAYS,
  RECERT_SEQUENCE_FLOOR,
  electionPeriodKindForSequence,
  electionPeriodScheduledEnd,
} from "../state-machines/election-period";
import { AdmissionStateError, type M6ErrorCode } from "../state-machines/errors";
import {
  F2F_EXCEPTION_GRACE_DAYS,
  F2F_PRIOR_WINDOW,
  TEXT_MINIMUMS,
} from "../state-machines/validation";

/** How the first benefit-period number of a new admission was established. */
export const BENEFIT_PERIOD_SOURCES = [
  /** Staff checked the beneficiary's periods in HETS / ELGA / ELGH and entered the confirmed number. */
  "hets_confirmed",
  /** Staff entered a number without confirming it against the CMS eligibility systems. */
  "staff_entered_unverified",
  /** The number is our own history's suggestion, accepted without an eligibility check. */
  "internal_history",
] as const;
export type BenefitPeriodSource = (typeof BENEFIT_PERIOD_SOURCES)[number];

/** A sane ceiling (≈ 30 years of 60-day periods); `election_period.sequence_number` is a smallint. */
export const MAX_BENEFIT_PERIOD_SEQUENCE = 200;
/** MBPM ch. 9 §20.1(5)(d) — the post-admission grace for a period-3+ NEW admission's F2F (and the death rule). */
export const F2F_EXCEPTION_DAYS_AFTER_ADMISSION = F2F_EXCEPTION_GRACE_DAYS;
/** Claims Processing Manual ch. 11 — a readmission within this many days continues the RHC day count. */
export const RHC_CARRYOVER_GAP_DAYS = RHC_CARRY_OVER_MAX_GAP_DAYS;
/** The RHC high rate covers days 1–60 of the (carried) day count. */
export const RHC_HIGH_RATE_DAYS = RHC_HIGH_TIER_LAST_DAY;
/** 42 CFR 418.24 / Claims Processing Manual ch. 11 §20.1.1 — NOE due 5 calendar days after the admission date
 *  (admission day is NOT day 1: admitted 10/10 ⇒ due 10/15). Matches M23's NOE `window_target_at` (+5). */
export const NOE_CALENDAR_DAYS = 5;
/** 42 CFR 418.54(a) / (b) — initial assessment within 48 hours, comprehensive within 5 calendar days (election =
 *  day 0). Defined once in ../certification/window-math (the compliance-window clocks use the same constants). */
export { COMPREHENSIVE_ASSESSMENT_DAYS, INITIAL_ASSESSMENT_DAYS };

// ── prior-episode facts (resolved by the caller from M6's own tables) ─────────────────────────────────

/** How one of the patient's earlier admissions with us ended. */
export type PriorEpisodeEndKind =
  | "live_discharge"
  | "revocation"
  | "transfer_out"
  | "death"
  | "unknown";

export interface PriorEpisodeFacts {
  readonly admissionId: string;
  /** First day of hospice care: the admission date (else the earliest ran period's `effective_at`). */
  readonly startedOn: LocalDate | null;
  /** The stay-ending effective date (discharge / revocation / transfer date). */
  readonly endedOn: LocalDate | null;
  readonly endKind: PriorEpisodeEndKind;
  /** The discharge reason on file (`no_longer_terminal`, `moved_out_of_service_area`, …), if any. */
  readonly dischargeType: string | null;
  /** The highest benefit period that actually RAN (active or completed) on that admission. */
  readonly lastRanSequence: number | null;
}

export type BenefitPeriodBasis =
  | "no_history"
  | "next_after_live_discharge"
  | "next_after_revocation"
  | "same_after_transfer"
  | "next_after_unknown_end";

export interface BenefitPeriodSuggestion {
  readonly suggestedSequence: number;
  readonly basis: BenefitPeriodBasis;
  /** The earlier admission the suggestion was derived from (`null` with no history). */
  readonly fromAdmissionId: string | null;
  readonly lastKnownSequence: number | null;
}

/** Episodes that actually ran a period, most recently ended first. */
function ranEpisodesNewestFirst(prior: readonly PriorEpisodeFacts[]): PriorEpisodeFacts[] {
  return prior
    .filter((p) => p.lastRanSequence !== null && p.lastRanSequence >= 1)
    .sort((a, b) => (b.endedOn ?? "").localeCompare(a.endedOn ?? ""));
}

/**
 * The suggested first benefit period for a new admission, from OUR history only. The latest episode that ran a
 * period decides: a live discharge or a revocation ended that period (the next one is available, +1); a transfer
 * out kept it running at the receiving hospice (same number — the other hospice may since have moved on, which is
 * exactly why staff must confirm it in HETS); a death or an unknown ending conservatively suggests +1.
 */
export function suggestBenefitPeriod(prior: readonly PriorEpisodeFacts[]): BenefitPeriodSuggestion {
  const latest = ranEpisodesNewestFirst(prior)[0];
  if (!latest || latest.lastRanSequence === null) {
    return {
      suggestedSequence: 1,
      basis: "no_history",
      fromAdmissionId: null,
      lastKnownSequence: null,
    };
  }
  const last = latest.lastRanSequence;
  const basis: BenefitPeriodBasis =
    latest.endKind === "transfer_out"
      ? "same_after_transfer"
      : latest.endKind === "revocation"
        ? "next_after_revocation"
        : latest.endKind === "live_discharge"
          ? "next_after_live_discharge"
          : "next_after_unknown_end";
  return {
    suggestedSequence: basis === "same_after_transfer" ? last : last + 1,
    basis,
    fromAdmissionId: latest.admissionId,
    lastKnownSequence: last,
  };
}

// ── the staff-entered benefit period (validated at the system boundary) ───────────────────────────────

export interface BenefitPeriodEntry {
  readonly sequence: number;
  readonly source: BenefitPeriodSource;
  /** The day staff checked HETS / ELGA / ELGH — required when `source` is `hets_confirmed`. */
  readonly confirmedOn?: LocalDate;
}

/** Refuse a malformed entry (422 with the offending field), before any write. */
export function assertBenefitPeriodEntry(entry: BenefitPeriodEntry, today: LocalDate): void {
  const fail = (field: string, code: M6ErrorCode, message: string): never => {
    throw new AdmissionStateError(code, message, [{ field, code, message }]);
  };
  if (
    !Number.isInteger(entry.sequence) ||
    entry.sequence < 1 ||
    entry.sequence > MAX_BENEFIT_PERIOD_SEQUENCE
  ) {
    fail(
      "benefitPeriod.sequence",
      "BENEFIT_PERIOD_INVALID",
      `The benefit period number must be a whole number from 1 to ${MAX_BENEFIT_PERIOD_SEQUENCE}`,
    );
  }
  if (entry.source === "hets_confirmed") {
    if (!entry.confirmedOn) {
      fail(
        "benefitPeriod.confirmedOn",
        "BENEFIT_PERIOD_CONFIRMATION_DATE_REQUIRED",
        "Enter the date the benefit period was confirmed against HETS / ELGA / ELGH",
      );
    } else if (entry.confirmedOn > today) {
      fail(
        "benefitPeriod.confirmedOn",
        "BENEFIT_PERIOD_CONFIRMATION_DATE_INVALID",
        "The confirmation date cannot be in the future",
      );
    }
  } else if (entry.confirmedOn) {
    fail(
      "benefitPeriod.confirmedOn",
      "BENEFIT_PERIOD_CONFIRMATION_DATE_INVALID",
      "A confirmation date is only recorded when the period was confirmed against HETS / ELGA / ELGH",
    );
  }
}

/** A documented exceptional circumstance for a period-3+ NEW admission's F2F (MBPM ch. 9 §20.1(5)(d)). */
export function assertF2fExceptionReason(reason: string | undefined, sequence: number): void {
  if (reason === undefined) return;
  const message =
    sequence < RECERT_SEQUENCE_FLOOR
      ? "A face-to-face exception only applies to an admission in benefit period 3 or later"
      : `Describe the exceptional circumstance in at least ${TEXT_MINIMUMS.f2fOverrideReason} characters`;
  if (sequence < RECERT_SEQUENCE_FLOOR || reason.trim().length < TEXT_MINIMUMS.f2fOverrideReason) {
    throw new AdmissionStateError("F2F_EXCEPTION_INVALID", message, [
      { field: "f2fException.reason", code: "F2F_EXCEPTION_INVALID", message },
    ]);
  }
}

// ── the requirements a chosen period carries ──────────────────────────────────────────────────────────

export interface BenefitPeriodRequirements {
  readonly sequence: number;
  readonly periodKind: "ninety_day" | "sixty_day";
  readonly lengthDays: number;
  readonly startDate: LocalDate;
  readonly endDate: LocalDate;
  readonly certification: {
    /** The hospice medical director / hospice physician always certifies. */
    readonly hospicePhysician: true;
    /** Period 1 only: the attending also certifies when the patient designated one (418.22(c)). */
    readonly attendingIfDesignated: boolean;
  };
  readonly faceToFace: {
    readonly required: boolean;
    /** The ordinary window: 30 calendar days before the period start through the period's first day
     *  (MBPM ch. 9 §20.1(5)(a)). */
    readonly windowStart: LocalDate | null;
    readonly windowEnd: LocalDate | null;
    /** With documented exceptional circumstances: an encounter through this day is still timely. */
    readonly exceptionWindowEnd: LocalDate | null;
  };
  readonly electionStatementRequired: true;
  /** The NOE (8xA) must be filed and accepted by this day (admission date + 5 calendar days). */
  readonly noeDueBy: LocalDate;
  /** 418.54(a) — 48 hours after the election, as the latest DATE those hours reach (election + 2). */
  readonly initialAssessmentDueBy: LocalDate;
  /** 418.54(b) — the last timely day: election date (day 0) + 5 calendar days (SOM App. M L523). */
  readonly comprehensiveAssessmentDueBy: LocalDate;
  /** HOPE Admission record — A0220 is the (re-)election date. */
  readonly hopeAdmissionA0220: LocalDate;
}

/** Everything a new admission owes for the benefit period it elects into, starting `startDate`. */
export function requirementsForBenefitPeriod(
  sequence: number,
  startDate: LocalDate,
): BenefitPeriodRequirements {
  const periodKind = electionPeriodKindForSequence(sequence);
  const f2fRequired = sequence >= RECERT_SEQUENCE_FLOOR;
  return {
    sequence,
    periodKind,
    lengthDays: ELECTION_PERIOD_LENGTH_DAYS[periodKind],
    startDate,
    endDate: electionPeriodScheduledEnd(startDate, periodKind),
    certification: { hospicePhysician: true, attendingIfDesignated: sequence === 1 },
    faceToFace: {
      required: f2fRequired,
      windowStart: f2fRequired
        ? addCalendarDays(startDate, -F2F_PRIOR_WINDOW.earliestDaysBefore)
        : null,
      windowEnd: f2fRequired
        ? addCalendarDays(startDate, -F2F_PRIOR_WINDOW.latestDaysBefore)
        : null,
      exceptionWindowEnd: f2fRequired
        ? addCalendarDays(startDate, F2F_EXCEPTION_DAYS_AFTER_ADMISSION)
        : null,
    },
    electionStatementRequired: true,
    noeDueBy: addCalendarDays(startDate, NOE_CALENDAR_DAYS),
    initialAssessmentDueBy: addCalendarDays(startDate, INITIAL_ASSESSMENT_DAYS),
    comprehensiveAssessmentDueBy: comprehensiveAssessmentDueOn(startDate),
    hopeAdmissionA0220: startDate,
  };
}

/**
 * Is a period-3+ admission's F2F satisfied by the exceptional-circumstance path? Only with a documented reason,
 * and then either an encounter on/after the start and within the 2-day grace, or the patient's death within it
 * (deemed complete).
 */
export function f2fExceptionSatisfied(input: {
  readonly startDate: LocalDate;
  readonly exceptionDocumented: boolean;
  readonly encounterDate: LocalDate | null;
  readonly deathOn: LocalDate | null;
}): boolean {
  if (!input.exceptionDocumented) return false;
  const graceEnd = addCalendarDays(input.startDate, F2F_EXCEPTION_DAYS_AFTER_ADMISSION);
  const within = (d: LocalDate | null): boolean => !!d && d >= input.startDate && d <= graceEnd;
  return within(input.encounterDate) || within(input.deathOn);
}

// ── two-tier RHC carry-over ───────────────────────────────────────────────────────────────────────────

export interface RhcCarryOver {
  /** True when readmitted within {@link RHC_CARRYOVER_GAP_DAYS} days of the latest discharge. */
  readonly applies: boolean;
  readonly daysSinceDischarge: number | null;
  /** Hospice days that carry into this admission's RHC day count, capped at 60 (0 when the count resets). */
  readonly priorHospiceDays: number;
  /** The first RHC day-count number this admission starts at (1 when the count resets). */
  readonly startsAtDay: number;
  /** Days left at the high rate (days 1–60) after the carry-over. */
  readonly highRateDaysRemaining: number;
}

/** One span of hospice days the count reads: an earlier stay with us, or a transfer-in's sending-hospice span
 *  (`rhcPriorStayFacts`, seams/prior-episodes.ts). Both ends are hospice days (ch. 11 §30.2 example: elected
 *  01/10, revoked 01/30 "accounts for 21 days"). */
export interface RhcCountableStay {
  readonly startedOn: LocalDate | null;
  readonly endedOn: LocalDate | null;
}

/**
 * The RHC day count an admission starting on `readmitOn` continues — the SAME rule as M23's `computeRhcCarryOver`
 * (both run `@wardenx/shared/rhc`): each span is clipped to the day before `readmitOn` (a transfer's hand-off day
 * is day 1 of the new stay), overlapping / next-day spans merge so a shared day counts once, and the walk back
 * continues while each gap is ≤ 60 days, stopping at the 60-day high tier (prior days are capped at 60). Pass
 * `rhcPriorStayFacts(...)` so a transfer-in's sending-hospice days count. Unlike M23 (which assumes an open span
 * ran until the next known care), a span with no recorded start or end is skipped: this count only informs the
 * readmission screen and M23's last-resort fallback, and M23 prices from the stays list whenever it has one.
 */
export function rhcCarryOver(
  prior: readonly RhcCountableStay[],
  readmitOn: LocalDate,
): RhcCarryOver {
  const electionDay = isoDateToEpochDay(readmitOn);
  const spans = electionDay === null ? [] : countablePriorSpans(prior, electionDay);
  // Unclipped: a stay ending ON the new start day (a same-day readmission / the transfer day) is 0 days ago.
  const lastCareDay = spans.reduce<number | null>((last, s) => {
    const lastDay = electionDay === null ? s.end : Math.min(s.end, electionDay);
    return last === null ? lastDay : Math.max(last, lastDay);
  }, null);
  const daysSinceDischarge =
    electionDay === null || lastCareDay === null ? null : electionDay - lastCareDay;
  const walked =
    electionDay === null
      ? null
      : walkCarryChain(mergeCarryBlocks(clipToBeforeElection(spans, electionDay)), electionDay);
  if (!walked || walked.blocks.length === 0) {
    return {
      applies: false,
      daysSinceDischarge,
      priorHospiceDays: 0,
      startsAtDay: 1,
      highRateDaysRemaining: RHC_HIGH_RATE_DAYS,
    };
  }
  const days = Math.min(walked.totalDays, RHC_HIGH_RATE_DAYS);
  return {
    applies: true,
    daysSinceDischarge,
    priorHospiceDays: days,
    startsAtDay: days + 1,
    highRateDaysRemaining: RHC_HIGH_RATE_DAYS - days,
  };
}

/** The spans with a readable start and end that began before the new start day, as epoch days. */
function countablePriorSpans(
  prior: readonly RhcCountableStay[],
  electionDay: number,
): { start: number; end: number }[] {
  return prior.flatMap((p) => {
    const start = isoDateToEpochDay(p.startedOn);
    const end = isoDateToEpochDay(p.endedOn);
    return start !== null && end !== null && end >= start && start < electionDay
      ? [{ start, end }]
      : [];
  });
}
