// apps/backend/src/modules/07-care-plan/lifecycle/overdue-gate.ts — M7-T04 the pure §2.6 CoP 418.56
// overdue computation behind `careplan.isReviewOverdue` (the encounter-sign gate M8 consumes via the
// CarePlanReader seam, §7.8). Two gates, both calendar-day clocks in the org timezone whose due dates
// are MAINTAINED as columns by M7's cron (M7-T07 sets `care_plan.initial_due_at` from admission
// activation and `care_plan.next_review_due_at` from the last signed version); this helper only decides
// whether `now` has crossed a gate, so the day math has ONE home shared by the reader and the cron.
//
//   • Initial (5-day) gate — §418.54(b): unsigned initial version blocks new encounter signs once the
//     5-day deadline lapses. Alerts fire at day 3/day 5; the SIGN gate engages at day 6 (a 1-day grace
//     past the day-5 deadline, §2.6 D2).
//   • Review (15-day) gate — §418.56(d): once an initial version is signed, IDG must re-review every 15
//     calendar days. Alerts fire at day 13/day 15; the SIGN gate engages at day 17 (a 2-day grace past
//     the day-15 due date, §2.6 D3).
//
// The gate is on encounter SIGNING, never chart access — a clinician always reads/documents; the system
// only blocks committing the visit until the plan is (re)signed. Pure & deterministic: `now` is injected.
import type { CarePlanId, CarePlanOverdueStatus, IsoInstant, PatientId } from "@wardenx/types";

/** Days past `initial_due_at` (day 5) before the initial-version sign gate engages — day 6 (§2.6 D2). */
export const INITIAL_GATE_GRACE_DAYS = 1;
/** Days past `next_review_due_at` (day 15) before the review sign gate engages — day 17 (§2.6 D3). */
export const REVIEW_GATE_GRACE_DAYS = 2;

const MS_PER_DAY = 86_400_000;

/** Add whole calendar days to an ISO instant (the due columns are stored end-of-day in the org tz). */
function addDays(iso: IsoInstant, days: number): number {
  return Date.parse(iso) + days * MS_PER_DAY;
}

/** The care-plan clock facts the gate decides over — the columns M7's cron maintains (§2.6). */
export interface CarePlanClockFacts {
  readonly planId: CarePlanId;
  readonly patientId: PatientId;
  /** Whether a `signed` initial version exists yet (clears the 5-day gate, arms the 15-day gate). */
  readonly hasSignedInitialVersion: boolean;
  /** `care_plan.initial_due_at` — election/activation + 5 calendar days, end-of-day org tz. */
  readonly initialDueAt: IsoInstant;
  /** `care_plan.next_review_due_at` — last signed version + 15 calendar days; null pre-first-signature. */
  readonly nextReviewDueAt: IsoInstant | null;
}

/**
 * Decide whether a care plan is past a CoP 418.56 sign gate as of `now` (§2.6, §7.8). Before the initial
 * version is signed only the 5-day gate can engage; once signed, only the 15-day review gate can. The
 * returned {@link CarePlanOverdueStatus} carries both gate booleans plus the raw due dates so M8 can
 * surface which clock blocked the sign and route the override (Clinical Supervisor + reason).
 */
export function evaluateCarePlanOverdue(
  facts: CarePlanClockFacts,
  now: IsoInstant,
): CarePlanOverdueStatus {
  const nowMs = Date.parse(now);
  const initialOverdue =
    !facts.hasSignedInitialVersion && nowMs >= addDays(facts.initialDueAt, INITIAL_GATE_GRACE_DAYS);
  const reviewOverdue =
    facts.hasSignedInitialVersion &&
    facts.nextReviewDueAt !== null &&
    nowMs >= addDays(facts.nextReviewDueAt, REVIEW_GATE_GRACE_DAYS);
  return {
    planId: facts.planId,
    patientId: facts.patientId,
    overdue: initialOverdue || reviewOverdue,
    initialOverdue,
    reviewOverdue,
    initialDueAt: facts.initialDueAt,
    nextReviewDueAt: facts.nextReviewDueAt,
  };
}
