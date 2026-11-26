// apps/web/src/modules/08-encounters/next-visit — the pure logic of the "Plan and Next Visit" section's schedule block: what the plan of
// care orders for the note's discipline, which of the patient's scheduled visits count toward it, and whether the section should say
// that nothing is scheduled or that the schedule falls short.
//
// ADVISORY ONLY. The plan of care (M7) and the scheduling module (M17) own these facts; this reads what they already expose and never
// decides eligibility, authorization or a lifecycle. Two small tables below are copies of M17's own (apps/web does not depend on
// @chartwarden/scheduling), each pinned to its source by a test: the machine form of a frequency and the visit purpose a discipline
// is scheduled for.

/** One intervention of the plan of care, as far as this section reads it. */
export interface PlanIntervention {
  readonly discipline: string;
  readonly frequencyText: string;
  /** The machine form, `count:unit:period` (M7 spec section 7.7). Not enforced by the care-plan route, so it may be anything. */
  readonly frequencyValue: string;
  readonly status: string;
}

/** A scheduled visit of the patient, as far as this section reads it. */
export interface UpcomingVisit {
  readonly id: string;
  readonly status: string;
  readonly visitPurpose: string;
  readonly scheduledStartedAt: string;
  /** The visit's day in the organization's time zone, as the server works it out (not the device's day of `scheduledStartedAt`). */
  readonly serviceDate: string;
}

export interface VisitCadence {
  readonly count: number;
  readonly period: "day" | "week" | "month";
  readonly periodDays: number;
}

/** What the plan of care orders as visits for the note's discipline, in the plan's own words. */
export interface OrderedVisitFrequency extends VisitCadence {
  readonly frequencyText: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The grammar and nominal period spans of packages/scheduling/src/frequency.ts (a test compares them with the source). */
const FREQUENCY_GRAMMAR =
  /^([0-9]+):(visit|day|week|month|prn|continuous):(day|week|month|episode|prn)$/;
const PERIOD_DAYS: Readonly<Record<VisitCadence["period"], number>> = {
  day: 1,
  week: 7,
  month: 30,
};

/**
 * The visit cadence of a care-plan frequency, or `null` when it is not one: only a count of VISITS per day, week or month is a cadence.
 * As-needed, continuous and per-episode orders, a zero count and free text carry no number to schedule against, so no claim is made.
 */
export function parseVisitFrequency(raw: string): VisitCadence | null {
  const match = FREQUENCY_GRAMMAR.exec(raw.trim());
  if (!match) return null;
  const count = Number(match[1]);
  const [unit, period] = [match[2], match[3]];
  if (unit !== "visit" || count < 1) return null;
  if (period !== "day" && period !== "week" && period !== "month") return null;
  return { count, period, periodDays: PERIOD_DAYS[period] };
}

/**
 * The group a discipline's visits are counted in. A nursing visit is one group whoever made it (RN or LPN), as is a physician visit (MD, DO
 * or NP, which the plan of care names `md_np`); speech therapy is `st` in the plan and `slp` on an encounter.
 */
export function noteDisciplineGroup(discipline: string): string {
  if (discipline === "rn" || discipline === "lpn") return "nursing";
  if (discipline === "md" || discipline === "np" || discipline === "md_np") return "physician";
  if (discipline === "slp") return "st";
  return discipline;
}

/** The discipline that usually makes each visit purpose; the first discipline of packages/scheduling `VISIT_PURPOSE_DISCIPLINES`. */
const PURPOSE_DISCIPLINE: Readonly<Record<string, string>> = {
  routine_visit: "rn",
  prn: "rn",
  aide_poc: "chha",
  msw_assessment: "msw",
  msw_followup: "msw",
  chaplain_visit: "chaplain",
  chaplain_assessment: "chaplain",
  volunteer_visit: "volunteer",
  f2f: "md",
  recert: "rn",
  loc_change: "rn",
  pronouncement: "rn",
  admission_visit: "rn",
  discharge_visit: "rn",
  huv1: "rn",
  huv2: "rn",
  sfv: "rn",
};

/**
 * The purposes packages/scheduling `VISIT_PURPOSE_DISCIPLINES` accepts more than one "Next visit by" discipline for (RN and LPN; RN, MD or
 * NP; RN, NP or LPN). The schedule names the purpose and the assigned clinician's membership, not that clinician's discipline, so for these
 * the discipline of the visit is not known and is left unstated (MD and NP are one choice, `md_np`).
 */
const SEVERAL_DISCIPLINES: ReadonlySet<string> = new Set([
  "routine_visit",
  "prn",
  "pronouncement",
  "huv1",
  "huv2",
  "sfv",
]);

/**
 * The discipline a scheduled visit of `purpose` is with, named the way the plan entry's "Next visit by" choice names it (`md_np` for the
 * physician or NP), or "" when the purpose does not settle it: one outside the table, or one several disciplines may make.
 */
export function visitByOf(purpose: string): string {
  if (!Object.hasOwn(PURPOSE_DISCIPLINE, purpose) || SEVERAL_DISCIPLINES.has(purpose)) return "";
  const discipline = PURPOSE_DISCIPLINE[purpose] as string;
  return discipline === "md" ? "md_np" : discipline;
}

const visitGroup = (purpose: string): string | null =>
  Object.hasOwn(PURPOSE_DISCIPLINE, purpose)
    ? noteDisciplineGroup(PURPOSE_DISCIPLINE[purpose] as string)
    : null;

/**
 * The discipline groups some visit purpose is scheduled for. A group outside it (PT, OT, speech) has no purpose its visits could carry,
 * so the schedule cannot be read against it: an empty count there would be an artefact of the table, not a fact about the patient.
 */
const SCHEDULABLE_GROUPS: ReadonlySet<string> = new Set(
  Object.values(PURPOSE_DISCIPLINE).map(noteDisciplineGroup),
);

export interface OrderedVisitReading {
  /** The most frequent readable visit order for the note's discipline, or null when the plan has none. */
  readonly ordered: OrderedVisitFrequency | null;
  /** The frequency, in the plan's words, of every other active order of the discipline: shown, never counted. */
  readonly otherOrders: readonly string[];
}

const rate = (cadence: VisitCadence): number => cadence.count / cadence.periodDays;

/**
 * What the plan of care orders as visits for this note's discipline. M17's proposal worker treats each active intervention's cadenced
 * visit frequency as a visit order, so the most frequent one is taken as the ordered visit frequency; an active order of the discipline that
 * is not a readable cadence is listed in the plan's words and left out of every count.
 */
export function orderedVisitFrequency(
  interventions: readonly PlanIntervention[],
  discipline: string,
): OrderedVisitReading {
  const group = noteDisciplineGroup(discipline);
  const active = interventions.filter(
    (i) => i.status === "active" && noteDisciplineGroup(i.discipline) === group,
  );
  let best: OrderedVisitFrequency | null = null;
  const otherOrders: string[] = [];
  for (const i of active) {
    const cadence = parseVisitFrequency(i.frequencyValue);
    if (cadence === null) {
      otherOrders.push(i.frequencyText);
    } else if (best === null || rate(cadence) > rate(best)) {
      best = { ...cadence, frequencyText: i.frequencyText };
    }
  }
  return { ordered: best, otherOrders };
}

export type ScheduleAssessment =
  /** No visit purpose is scheduled for the note's discipline: nothing is said about its schedule. */
  | { readonly kind: "not_comparable" }
  | { readonly kind: "nothing_scheduled" }
  | { readonly kind: "scheduled_without_order"; readonly nextVisitId: string }
  | { readonly kind: "meets_frequency"; readonly nextVisitId: string }
  | {
      readonly kind: "short_of_frequency";
      readonly scheduled: number;
      readonly expected: number;
      readonly windowDays: number;
      readonly nextVisitId: string;
    };

/** Days a daily order is read over: seven visits in the next seven days, as the weekly orders are read over a week. */
const DAILY_LOOKAHEAD_DAYS = 7;

/** Visits that still lie ahead and are committed: published or on the way, starting at or after `now`. */
const isUpcoming = (visit: UpcomingVisit, now: Date): boolean =>
  (visit.status === "published" || visit.status === "en_route") &&
  Date.parse(visit.scheduledStartedAt) >= now.getTime();

/** The committed future visits, soonest first, leaving out the visit this note documents. */
export function upcomingVisits(
  visits: readonly UpcomingVisit[],
  now: Date,
  currentVisitId: string | null,
): readonly UpcomingVisit[] {
  return visits
    .filter((v) => v.id !== currentVisitId && isUpcoming(v, now))
    .sort((a, b) => Date.parse(a.scheduledStartedAt) - Date.parse(b.scheduledStartedAt));
}

/**
 * Whether the schedule matches what the plan orders. Counted are the patient's committed future visits of the note's discipline group,
 * leaving out this note's own visit. A weekly order is met by that many in the next seven days (the last day included), a daily one by
 * seven, a monthly one by its count in the next thirty. A rolling window from now is an approximation of "per week": it is a prompt to look
 * at the schedule, not a compliance finding.
 */
export function assessSchedule(input: {
  readonly now: Date;
  readonly discipline: string;
  readonly ordered: OrderedVisitFrequency | null;
  readonly visits: readonly UpcomingVisit[];
  readonly currentVisitId: string | null;
}): ScheduleAssessment {
  const group = noteDisciplineGroup(input.discipline);
  if (!SCHEDULABLE_GROUPS.has(group)) return { kind: "not_comparable" };
  const counted = upcomingVisits(input.visits, input.now, input.currentVisitId).filter(
    (v) => visitGroup(v.visitPurpose) === group,
  );
  const next = counted[0];
  if (next === undefined) return { kind: "nothing_scheduled" };
  if (input.ordered === null) return { kind: "scheduled_without_order", nextVisitId: next.id };

  const windowDays =
    input.ordered.period === "day" ? DAILY_LOOKAHEAD_DAYS : input.ordered.periodDays;
  const expected =
    input.ordered.period === "day"
      ? input.ordered.count * DAILY_LOOKAHEAD_DAYS
      : input.ordered.count;
  const windowEnd = input.now.getTime() + windowDays * MS_PER_DAY;
  const scheduled = counted.filter((v) => Date.parse(v.scheduledStartedAt) <= windowEnd).length;
  return scheduled >= expected
    ? { kind: "meets_frequency", nextVisitId: next.id }
    : { kind: "short_of_frequency", scheduled, expected, windowDays, nextVisitId: next.id };
}

/**
 * Where "Schedule next visit" goes: the Scheduling calendar with the New Visit form open for this patient (the scheduler's own form
 * decides the purpose, the day and who is eligible). Only the patient id, which the patient-chart links to the same screen carry: no visit
 * purpose or date is put in the URL, since it reaches browser history and access logs.
 */
export function scheduleNextVisitHref(patientId: string): string {
  return `/calendar?${new URLSearchParams({ patient: patientId, newVisit: "1" }).toString()}`;
}
