import { INITIAL_ASSESSMENT_CLOCKS } from "@chartwarden/discipline-plans";
// apps/backend/src/modules/15-discipline-care-plans/lifecycle/initial-clock.ts — M15-T03 (§1.1 D10,
// §7.2, §7.3).
//
// The per-kind initial-assessment clocks: the MSW 5-day psychosocial clock (CoP 418.54(c)), the chaplain
// 5-day spiritual clock that a typed DECLINATION also satisfies (§7.3), the Aide POC 14-day signed-version
// clock, and the volunteer plan's 5-BUSINESS-day finalize clock. The catalog itself (anchor, days,
// business-vs-calendar, warn mark, satisfier) is pure data in `@chartwarden/discipline-plans`
// (`INITIAL_ASSESSMENT_CLOCKS`); this module owns the DAY MATH and the satisfaction verdict, so the daily
// overdue crons (M15-T06), the plan-detail banner and the M30 on-time-rate measure all read one answer.
//
// PURE & deterministic — `now` and every plan column are injected, no `Date.now()`, no IO. Business days
// are Mon–Fri (agency holidays are a Phase-4 calendar concern; the spec names business days, not holidays).
import type { DisciplinePlanKind, IsoInstant } from "@chartwarden/types";

const MS_PER_DAY = 86_400_000;

/** Add whole CALENDAR days to an instant. */
function addCalendarDays(iso: IsoInstant, days: number): number {
  return Date.parse(iso) + days * MS_PER_DAY;
}

/** Add whole BUSINESS days (Mon–Fri) to an instant — the §1.1 volunteer-plan clock. */
function addBusinessDays(iso: IsoInstant, days: number): number {
  let ms = Date.parse(iso);
  let remaining = days;
  while (remaining > 0) {
    ms += MS_PER_DAY;
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return ms;
}

/** The plan columns the D10 clock decides over (§1.1). */
export interface InitialClockFacts {
  readonly kind: DisciplinePlanKind;
  /** `discipline_care_plan.initial_assessment_clock_started_at` — the D10 anchor set at bootstrap. */
  readonly clockStartedAt: IsoInstant | null;
  /** `discipline_care_plan.initial_assessment_signed_at` — set by the signed INITIAL assessment/version. */
  readonly initialAssessmentSignedAt: IsoInstant | null;
  /** `discipline_care_plan.spiritual_care_declined_at` — satisfies the chaplain clock alone (§7.3). */
  readonly spiritualCareDeclinedAt: IsoInstant | null;
}

/** The D10 verdict for one plan (§1.1 / §7.2 / §7.3). */
export interface InitialClockState {
  readonly kind: DisciplinePlanKind;
  /** The instant the clock lapses; null when no clock is armed (no anchor recorded yet). */
  readonly dueAt: IsoInstant | null;
  /** The pre-breach warn mark (§7.2 day 3); null for the kinds the spec gives no warning. */
  readonly warnAt: IsoInstant | null;
  /** True once a signed initial artifact (or, for the spiritual plan, a declination) closed the clock. */
  readonly satisfied: boolean;
  /** True when the clock lapsed unsatisfied as of `now` — the `*_initial_overdue` events fire on this. */
  readonly overdue: boolean;
  /** True in the warn window: past `warnAt`, not yet past `dueAt`, still unsatisfied. */
  readonly warning: boolean;
  /** Whole days past `dueAt` (0 when not overdue) — the `daysOverdue` field of the §2.4 payloads. */
  readonly daysOverdue: number;
}

/**
 * §7.3 — the spiritual plan's clock is satisfied by EITHER a signed initial assessment OR a recorded
 * declination. Every other kind is satisfied only by its signed initial artifact. (The satisfier is
 * declared per kind in `INITIAL_ASSESSMENT_CLOCKS[kind].satisfiedBy`; this reads that declaration rather
 * than re-deciding it, so adding a kind cannot silently skip the declination path.)
 */
export function isInitialClockSatisfied(facts: InitialClockFacts): boolean {
  if (facts.initialAssessmentSignedAt !== null) return true;
  const satisfiedBy = INITIAL_ASSESSMENT_CLOCKS[facts.kind].satisfiedBy;
  return (
    satisfiedBy === "signed_initial_assessment_or_declination" &&
    facts.spiritualCareDeclinedAt !== null
  );
}

/**
 * Evaluate the §1.1 D10 initial clock for one plan as of `now`. Returns `dueAt: null` (never overdue)
 * when no anchor is recorded — a volunteer plan whose lazy bootstrap has not happened has no obligation,
 * and inventing one would raise a false survey flag.
 */
export function evaluateInitialClock(facts: InitialClockFacts, now: IsoInstant): InitialClockState {
  const clock = INITIAL_ASSESSMENT_CLOCKS[facts.kind];
  const satisfied = isInitialClockSatisfied(facts);

  if (facts.clockStartedAt === null) {
    return {
      kind: facts.kind,
      dueAt: null,
      warnAt: null,
      satisfied,
      overdue: false,
      warning: false,
      daysOverdue: 0,
    };
  }

  const add = clock.businessDays ? addBusinessDays : addCalendarDays;
  const dueMs = add(facts.clockStartedAt, clock.dueWithinDays);
  const warnMs = clock.warnAtDays === null ? null : add(facts.clockStartedAt, clock.warnAtDays);
  const nowMs = Date.parse(now);

  const overdue = !satisfied && nowMs >= dueMs;
  return {
    kind: facts.kind,
    dueAt: new Date(dueMs).toISOString(),
    warnAt: warnMs === null ? null : new Date(warnMs).toISOString(),
    satisfied,
    overdue,
    warning: !satisfied && warnMs !== null && nowMs >= warnMs && nowMs < dueMs,
    daysOverdue: overdue ? Math.floor((nowMs - dueMs) / MS_PER_DAY) : 0,
  };
}
