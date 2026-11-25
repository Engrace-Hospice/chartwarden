import { visitPurposeLabel } from "@chartwarden/types";
// apps/web/src/modules/08-encounters/next-visit — the schedule block of the "Plan and Next Visit" section: the patient's upcoming visits
// (read only), what the plan of care orders for this discipline, an advisory when nothing is scheduled or the schedule is short, and the
// link that opens the Scheduling screen to book the next visit.
//
// ADVISORY ONLY and read only. Scheduling (M17) and the plan of care (M7) own every fact here and the server decides who may book what;
// this block neither books a visit nor blocks the note. "Schedule next visit" is a link to the scheduler's own New Visit form for this
// patient (the link carries the patient id and nothing else: the purpose and the day are chosen there). It opens in a new tab so the note,
// and anything unsaved in it, stays where it is; the schedule is read again when the clinician comes back to this tab
// (use-next-visit-context), so a visit booked there shows up here.
import { InlineAlert, LoadingSpinner } from "@chartwarden/ui";
import { type JSX, useId } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../../../shell/session";
import {
  type ScheduleAssessment,
  assessSchedule,
  orderedVisitFrequency,
  scheduleNextVisitHref,
  upcomingVisits,
} from "./next-visit-model";
import { PLAN_VISIT_BY_OPTIONS } from "./plan-entry-text";
import { type NextVisitContext, SCHEDULE_LOOKAHEAD_DAYS } from "./use-next-visit-context";

const UPCOMING_SHOWN = 4;

const disciplineLabel = (discipline: string): string =>
  PLAN_VISIT_BY_OPTIONS.find((o) => o.value === discipline)?.label ?? discipline.toUpperCase();

const whenLabel = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const visitWord = (n: number): string => (n === 1 ? "visit" : "visits");

function advisoryOf(
  assessment: ScheduleAssessment,
  discipline: string,
  orderedText: string | null,
): { readonly tone: "warning" | "info"; readonly text: string } | null {
  const who = disciplineLabel(discipline);
  switch (assessment.kind) {
    case "nothing_scheduled":
      return {
        tone: "warning",
        text: `No ${who} visit is scheduled in the next ${SCHEDULE_LOOKAHEAD_DAYS} days that you can see.`,
      };
    case "short_of_frequency":
      return {
        tone: "warning",
        text: `${assessment.scheduled} ${visitWord(assessment.scheduled)} scheduled in the next ${assessment.windowDays} days; the plan of care orders ${orderedText ?? "more"}.`,
      };
    default:
      return null;
  }
}

export interface NextVisitScheduleProps {
  readonly patientId: string;
  readonly discipline: string;
  readonly currentVisitId: string | null;
  readonly context: NextVisitContext;
  readonly now: Date;
}

export function NextVisitSchedule({
  patientId,
  discipline,
  currentVisitId,
  context,
  now,
}: NextVisitScheduleProps): JSX.Element {
  const { schedule, plan } = context;
  const hintId = useId();
  const permissions = useSession()?.permissions;
  const canCreate = permissions?.includes("visit.create") === true;
  const canRead = permissions?.includes("visit.read") === true;

  const reading =
    plan.status === "ready" ? orderedVisitFrequency(plan.value.interventions, discipline) : null;
  const ordered = reading?.ordered ?? null;
  const upcoming =
    schedule.status === "ready" ? upcomingVisits(schedule.value, now, currentVisitId) : [];
  const assessment =
    schedule.status === "ready"
      ? assessSchedule({ now, discipline, ordered, visits: schedule.value, currentVisitId })
      : null;
  const advisory = assessment
    ? advisoryOf(assessment, discipline, ordered?.frequencyText ?? null)
    : null;

  const href = scheduleNextVisitHref(patientId);

  return (
    <section className="wx-form-stack" aria-label="Next visit and schedule">
      <h4 className="wx-section-title">Next visit and schedule</h4>

      {schedule.status === "loading" || plan.status === "loading" ? (
        <LoadingSpinner label="Loading the schedule and the plan of care" />
      ) : null}

      {schedule.status === "unavailable" ? (
        <InlineAlert tone="warning">
          {schedule.forbidden
            ? "You do not have access to this patient's schedule, so upcoming visits are not shown."
            : "The schedule could not be read, so upcoming visits are not shown. Nothing is implied about whether a visit is booked."}
        </InlineAlert>
      ) : null}

      {schedule.status === "ready" ? (
        upcoming.length > 0 ? (
          <ul className="wx-bullet-list" aria-label="Upcoming scheduled visits">
            {upcoming.slice(0, UPCOMING_SHOWN).map((v) => (
              <li key={v.id}>
                {whenLabel(v.scheduledStartedAt)} ·{" "}
                {visitPurposeLabel(v.visitPurpose) ?? v.visitPurpose}
              </li>
            ))}
          </ul>
        ) : (
          <p className="wx-form-hint">
            No visits that you can see are scheduled in the next {SCHEDULE_LOOKAHEAD_DAYS} days.
          </p>
        )
      ) : null}

      {plan.status === "unavailable" ? (
        <p className="wx-form-hint">
          The plan of care could not be read, so its ordered visit frequency is not shown.
        </p>
      ) : null}
      {ordered !== null ? (
        <p className="wx-form-hint">
          Plan of care orders for {disciplineLabel(discipline)}: {ordered.frequencyText}.
        </p>
      ) : null}
      {reading !== null && ordered === null ? (
        <p className="wx-form-hint">
          {reading.otherOrders.length > 0
            ? `The plan of care lists no visit frequency for ${disciplineLabel(discipline)} that can be compared with the schedule (${reading.otherOrders.join("; ")}).`
            : `The plan of care lists no visit frequency for ${disciplineLabel(discipline)}.`}
        </p>
      ) : null}

      {advisory ? <InlineAlert tone={advisory.tone}>{advisory.text}</InlineAlert> : null}
      {assessment?.kind === "meets_frequency" ? (
        <InlineAlert tone="success">
          The schedule includes the ordered number of visits.
        </InlineAlert>
      ) : null}

      {canCreate ? (
        <p>
          <Link
            to={href}
            target="_blank"
            rel="noopener noreferrer"
            className="wx-btn-secondary wx-btn-sm"
            aria-describedby={hintId}
          >
            Schedule next visit
          </Link>{" "}
          <span id={hintId} className="wx-form-hint">
            Opens Scheduling in a new tab for this patient; your note stays as it is.
          </span>
        </p>
      ) : canRead ? (
        <p>
          <Link
            to={`/calendar?patient=${encodeURIComponent(patientId)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="wx-btn-secondary wx-btn-sm"
            aria-describedby={hintId}
          >
            Open this patient's schedule
          </Link>{" "}
          <span id={hintId} className="wx-form-hint">
            Booking a visit needs the scheduling permission; ask a scheduler to book the next visit.
          </span>
        </p>
      ) : null}
    </section>
  );
}
