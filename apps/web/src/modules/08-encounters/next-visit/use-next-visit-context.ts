// apps/web/src/modules/08-encounters/next-visit — what the "Plan and Next Visit" section reads about the patient's schedule and plan of care.
//
// Three READS through the typed client, each under its own existing permission, so a viewer who may not read one still gets the others:
// the patient's upcoming visits (M17, `visit.read`, scoped by the server), the plan of care's interventions (M7), and this visit's own
// proposed plan changes (M7). A refusal or a failed read is "unavailable" and the section says so; it never reads as "nothing scheduled".
import { type ApiClient, useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import {
  listVisitProposals,
  loadCarePlan,
} from "../../07-care-plan/change-proposals/change-proposals-api";
import type { PlanIntervention, UpcomingVisit } from "./next-visit-model";

export type Remote<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "unavailable"; readonly forbidden: boolean };

const LOADING = { status: "loading" } as const;
const FORBIDDEN = 403;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** How far ahead the schedule is read: far enough for a monthly order (the longest cadence the plan's machine form reads). */
export const SCHEDULE_LOOKAHEAD_DAYS = 30;

/** What the plan of care says, as far as this section reads it. */
export interface PlanReading {
  /** The plan has no interventions to read: no plan yet, or one the viewer sees redacted. */
  readonly interventions: readonly PlanIntervention[];
  readonly planId: string | null;
}

async function readVisits(
  client: ApiClient,
  patientId: string,
  now: Date,
): Promise<Remote<readonly UpcomingVisit[]>> {
  try {
    const { data, error, response } = await client.GET("/api/v1/visits", {
      params: {
        query: {
          patient: patientId,
          from: now.toISOString(),
          to: new Date(now.getTime() + SCHEDULE_LOOKAHEAD_DAYS * MS_PER_DAY).toISOString(),
        },
      },
    });
    if (error !== undefined || !data) {
      return { status: "unavailable", forbidden: response?.status === FORBIDDEN };
    }
    return {
      status: "ready",
      value: data.map((v) => ({
        id: v.id,
        status: v.status,
        visitPurpose: v.visitPurpose,
        scheduledStartedAt: v.scheduledStartedAt,
      })),
    };
  } catch {
    return { status: "unavailable", forbidden: false };
  }
}

async function readPlan(client: ApiClient, patientId: string): Promise<Remote<PlanReading>> {
  const result = await loadCarePlan(client, patientId);
  if (!result.ok) return { status: "unavailable", forbidden: result.status === FORBIDDEN };
  const plan = result.value;
  // A plan answered redacted (Part 2 filtering) carries no readable interventions: say unavailable, never "no orders".
  if (plan?.redacted === true) return { status: "unavailable", forbidden: true };
  return {
    status: "ready",
    value: { interventions: plan?.interventions ?? [], planId: plan?.id ?? null },
  };
}

async function readDraftProposals(
  client: ApiClient,
  patientId: string,
  encounterId: string,
): Promise<Remote<number>> {
  const result = await listVisitProposals(client, patientId, encounterId);
  if (!result.ok) return { status: "unavailable", forbidden: result.status === FORBIDDEN };
  const open = result.value.proposals.filter((p) => p.status === "draft" || p.status === "pending");
  return { status: "ready", value: open.length };
}

export interface NextVisitContext {
  readonly schedule: Remote<readonly UpcomingVisit[]>;
  /** When the read that produced `schedule` was made: the moment its windows are worked out from. Null until one lands. */
  readonly scheduleReadAt: Date | null;
  readonly plan: Remote<PlanReading>;
  /** This visit's proposed plan changes still waiting (drafts, or pending the case manager's review). */
  readonly proposals: Remote<number>;
}

/** The schedule as last read, and the moment that read was made. */
interface ScheduleReading {
  readonly remote: Remote<readonly UpcomingVisit[]>;
  readonly readAt: Date | null;
}

const LOADING_SCHEDULE: ScheduleReading = { remote: LOADING, readAt: null };

/**
 * Two reads of the schedule are never started closer together than this. Coming back to a tab fires focus and visibility together, and
 * each return reads 30 days of the patient's visits; a visit booked in the other tab is picked up by the next return after the gap.
 */
const MIN_SCHEDULE_READ_GAP_MS = 30_000;

/**
 * A re-read that failed (not a refusal) leaves the schedule the clinician already has on screen: a dropped connection is not news about
 * the schedule. A refusal replaces it, and the first read has nothing to keep.
 */
function nextSchedule(held: ScheduleReading, read: ScheduleReading): ScheduleReading {
  const failed = read.remote.status === "unavailable" && !read.remote.forbidden;
  return failed && held.remote.status === "ready" ? held : read;
}

/**
 * Read the schedule, the plan and this visit's proposals. The proposals are read again when `planStepBusy` goes from true to false, i.e.
 * when a save in the plan-of-care step below has finished (a read made mid-save would be stale). The plan is read once per note. The
 * schedule is read again whenever the clinician comes back to this window or tab, and when `listening` turns on again: the panel sends
 * them to Scheduling in a new tab to book, so the schedule can change while this screen is open. Reads are spaced, only the latest is
 * kept, a failed one keeps the schedule already shown, and none is made while `listening` is off (the panel is mounted but hidden).
 */
export function useNextVisitContext(
  patientId: string,
  encounterId: string,
  planStepBusy: boolean,
  listening: boolean,
): NextVisitContext {
  const client = useApiClient();
  const [schedule, setSchedule] = useState<ScheduleReading>(LOADING_SCHEDULE);
  const listeningRef = useRef(listening);
  const refreshSchedule = useRef<() => void>(() => undefined);
  const [plan, setPlan] = useState<Remote<PlanReading>>(LOADING);
  const [proposals, setProposals] = useState<Remote<number>>(LOADING);
  // Counts the plan-of-care saves that have finished: derived while rendering, so the render that sees the step go idle already has it.
  const [wasBusy, setWasBusy] = useState(planStepBusy);
  const [savesFinished, setSavesFinished] = useState(0);
  if (wasBusy !== planStepBusy) {
    setWasBusy(planStepBusy);
    if (wasBusy) setSavesFinished((count) => count + 1);
  }

  useEffect(() => {
    let active = true;
    setPlan(LOADING);
    void readPlan(client, patientId).then((r) => active && setPlan(r));
    return () => {
      active = false;
    };
  }, [client, patientId]);

  // Opening the section again reads the schedule, which may have changed while it was out of sight (a read just made is not repeated).
  useEffect(() => {
    listeningRef.current = listening;
    if (listening) refreshSchedule.current();
  }, [listening]);

  useEffect(() => {
    let active = true;
    let latestRead = 0;
    let lastStartedAt = Number.NEGATIVE_INFINITY;
    const readSchedule = (): void => {
      const startedAt = Date.now();
      if (startedAt - lastStartedAt < MIN_SCHEDULE_READ_GAP_MS) return;
      lastStartedAt = startedAt;
      latestRead += 1;
      const thisRead = latestRead;
      const readAt = new Date(startedAt);
      void readVisits(client, patientId, readAt).then((remote) => {
        if (active && thisRead === latestRead) {
          setSchedule((held) => nextSchedule(held, { remote, readAt }));
        }
      });
    };
    const refresh = (): void => {
      if (listeningRef.current) readSchedule();
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    refreshSchedule.current = refresh;
    setSchedule(LOADING_SCHEDULE);
    readSchedule();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      refreshSchedule.current = () => undefined;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [client, patientId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: savesFinished re-reads the proposals after the plan-of-care step saved something.
  useEffect(() => {
    let active = true;
    void readDraftProposals(client, patientId, encounterId).then((r) => active && setProposals(r));
    return () => {
      active = false;
    };
  }, [client, patientId, encounterId, savesFinished]);

  return { schedule: schedule.remote, scheduleReadAt: schedule.readAt, plan, proposals };
}
