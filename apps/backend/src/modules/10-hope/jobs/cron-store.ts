// apps/backend/src/modules/10-hope/jobs/cron-store.ts — the org-wide Drizzle reader/writer queries backing
// the M10 `hope-window-watchdog` / `sfv-watchdog` cron workers (./cron-workers.ts, TASK-040D). No such
// org-wide queries existed before this file: hope-route-service-db.ts's methods are all single-schedule /
// single-SFV-id-scoped, request-bound reads/writes (a route handler already knows which row it wants) — the
// watchdogs instead need "every open schedule in this org" / "every open-or-overdue SFV in this org".
//
// seams/org-rollup-store.ts (M10's OTHER org-wide Drizzle reader, built for M30's HQRP rollups, #107) was
// checked first per the task brief: it is AGGREGATE-ONLY by design (D6 — only reduced counts may cross that
// seam, never a raw row with an id), so its query SHAPES are not reusable here (the watchdogs need per-row
// scheduleId/sfvId to drive a transition + a targeted UPDATE). Its TENANCY pattern is reused: one
// `withOrgContext` per org (opened by the caller, cron-workers.ts) PLUS a belt-and-suspenders
// `WHERE organization_id = $org` predicate on top of RLS (its own HARD RULE 1 comment).
import { type DbClient, schema } from "@chartwarden/db";
import type { HopeScheduleStatus, HopeSfvStatus } from "@chartwarden/types";
import { and, asc, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { HopeScheduleSnapshot, SfvWatchdogSnapshot } from "./index";

const SCHED = schema.hopeTimepointSchedules;
const SFV = schema.symptomFollowUpVisits;
const HA = schema.hopeAssessments;

/**
 * No per-org IANA timezone seam exists yet — `symptom_follow_up_visit` has no timezone column, and neither
 * does `organizations` (confirmed by prior research). Every module that needs one hardcodes this same
 * fallback (M6/M7/M15 precedent); do not cross-import M7's `lifecycle/gate-clock.ts` (a different module's
 * internal file — would violate module boundaries).
 */
export const DEFAULT_ORG_TIME_ZONE = "America/Los_Angeles";

/**
 * Every `open` `hope_timepoint_schedule` row in `organizationId` — the `hope-window-watchdog` input
 * snapshot. Filters on exactly `(organizationId, status)`, matching `idx_hope_sched_by_org_window`
 * `(organizationId, status, windowClosesAt)` (`packages/db/src/schema/hope/hope-timepoint-schedules.ts`).
 */
export async function openHopeSchedulesForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<HopeScheduleSnapshot[]> {
  const rows = await tx
    .select({
      id: SCHED.id,
      patientId: SCHED.patientId,
      admissionId: SCHED.admissionId,
      rfaKind: SCHED.rfaKind,
      status: SCHED.status,
      windowOpensAt: SCHED.windowOpensAt,
      windowClosesAt: SCHED.windowClosesAt,
      lateDeadlineAt: SCHED.lateDeadlineAt,
    })
    .from(SCHED)
    .where(and(eq(SCHED.organizationId, organizationId), eq(SCHED.status, "open")))
    // A fixed order: the watchdog flips these rows one by one, and two overlapping ticks that touched them in different
    // orders could deadlock each other (the SFV watchdog's snapshot is ordered the same way).
    .orderBy(asc(SCHED.id));
  return rows.map(toScheduleSnapshot);
}

type ScheduleSnapshotRow = {
  id: string;
  patientId: string;
  admissionId: string;
  rfaKind: HopeScheduleSnapshot["rfaKind"];
  status: HopeScheduleStatus;
  windowOpensAt: Date;
  windowClosesAt: Date;
  lateDeadlineAt: Date;
};

const toScheduleSnapshot = (r: ScheduleSnapshotRow): HopeScheduleSnapshot => ({
  scheduleId: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  rfaKind: r.rfaKind,
  status: r.status,
  windowOpensAt: r.windowOpensAt.toISOString(),
  windowClosesAt: r.windowClosesAt.toISOString(),
  lateDeadlineAt: r.lateDeadlineAt.toISOString(),
});

/**
 * The schedules the watchdog flipped to `expired` since `since` (the alert REPLAY window): the input the tick re-plans
 * its alerts from, so an alert whose emit failed is retried by the next tick instead of being lost with the one tick
 * that saw the transition. Ordered by id.
 */
export async function recentlyExpiredSchedulesForOrg(
  tx: DbClient,
  organizationId: string,
  since: Date,
): Promise<HopeScheduleSnapshot[]> {
  const rows = await tx
    .select({
      id: SCHED.id,
      patientId: SCHED.patientId,
      admissionId: SCHED.admissionId,
      rfaKind: SCHED.rfaKind,
      status: SCHED.status,
      windowOpensAt: SCHED.windowOpensAt,
      windowClosesAt: SCHED.windowClosesAt,
      lateDeadlineAt: SCHED.lateDeadlineAt,
    })
    .from(SCHED)
    .where(
      and(
        eq(SCHED.organizationId, organizationId),
        eq(SCHED.status, "expired"),
        gte(SCHED.updatedAt, since),
      ),
    )
    .orderBy(asc(SCHED.id));
  return rows.map(toScheduleSnapshot);
}

/**
 * Flip one schedule from `open` to its new status (called only for the watchdog's `changed===true` transitions).
 * The UPDATE only matches a row that is STILL `open`: a clinician's sign (which completes the schedule through the
 * `schedule-mark-completed` trigger) that committed between the watchdog's unlocked snapshot and this write must not
 * be overwritten `completed` -> `expired`, and an overlapping tick that already expired it must not announce it twice.
 * Returns whether a row was written; `false` is a benign lost race, and the caller must not publish the event.
 */
export async function updateHopeScheduleStatus(
  tx: DbClient,
  scheduleId: string,
  status: HopeScheduleStatus,
): Promise<boolean> {
  const rows = await tx
    .update(SCHED)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(SCHED.id, scheduleId), eq(SCHED.status, "open")))
    .returning({ id: SCHED.id });
  return rows.length > 0;
}

/**
 * Every `open`/`overdue` `symptom_follow_up_visit` row in `organizationId` — the `sfv-watchdog` input
 * snapshot. Both statuses are needed: an `open` row may have just crossed `due_at` (→ overdue), and an
 * already-`overdue` row may cross to `missed`, or simply re-emit `m10.hope.sfv_overdue` at a new
 * hours-past-due bucket without changing status (see planSfvWatchdog in ./index). Filters on exactly
 * `(organizationId, status)`, matching `idx_sfv_org_due_at` `(organizationId, status, dueAt)`. `timeZone`
 * has no column source (see {@link DEFAULT_ORG_TIME_ZONE}) — stamped on every mapped row.
 */
export async function openOrOverdueSfvsForOrg(
  tx: DbClient,
  organizationId: string,
): Promise<SfvWatchdogSnapshot[]> {
  const rows = await tx
    .select({
      id: SFV.id,
      patientId: SFV.patientId,
      triggeringAssessmentId: SFV.triggeringAssessmentId,
      admissionId: HA.admissionId,
      status: SFV.status,
      dueAt: SFV.dueAt,
    })
    .from(SFV)
    .leftJoin(HA, eq(HA.id, SFV.triggeringAssessmentId))
    .where(and(eq(SFV.organizationId, organizationId), inArray(SFV.status, ["open", "overdue"])))
    // A fixed order: the watchdog flips these rows one by one, and two overlapping ticks (or a tick and a
    // `recordSfv` / `patchAnswers` holding row locks) that touched them in different orders could deadlock.
    .orderBy(asc(SFV.id));
  return rows.map(toSfvSnapshot);
}

const toSfvSnapshot = (r: {
  id: string;
  patientId: string;
  admissionId: string | null;
  triggeringAssessmentId: string;
  status: HopeSfvStatus;
  dueAt: Date;
}): SfvWatchdogSnapshot => ({
  sfvId: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  triggeringAssessmentId: r.triggeringAssessmentId,
  status: r.status,
  dueAt: r.dueAt.toISOString(),
  timeZone: DEFAULT_ORG_TIME_ZONE,
});

/**
 * The SFVs whose alerts the tick (re-)plans: every `overdue` one (bounded by the `overdue -> missed` decay at 7 days
 * past due) and every `missed` one since `missedSince` (the replay window). Re-planning from the database state, rather
 * than only from this tick's transitions, is what lets a failed alert emit be retried by the next tick. Ordered by id.
 */
export async function sfvsToReplayAlertsForOrg(
  tx: DbClient,
  organizationId: string,
  missedSince: Date,
): Promise<SfvWatchdogSnapshot[]> {
  const rows = await tx
    .select({
      id: SFV.id,
      patientId: SFV.patientId,
      triggeringAssessmentId: SFV.triggeringAssessmentId,
      admissionId: HA.admissionId,
      status: SFV.status,
      dueAt: SFV.dueAt,
    })
    .from(SFV)
    .leftJoin(HA, eq(HA.id, SFV.triggeringAssessmentId))
    .where(
      and(
        eq(SFV.organizationId, organizationId),
        or(
          eq(SFV.status, "overdue"),
          and(eq(SFV.status, "missed"), gte(SFV.updatedAt, missedSince)),
        ),
      ),
    )
    .orderBy(asc(SFV.id));
  return rows.map(toSfvSnapshot);
}

/** One planned watchdog decay of an SFV: from the status its snapshot read to the status the plan chose. */
export interface SfvStatusFlip {
  readonly sfvId: string;
  /** The status the watchdog's snapshot read; the UPDATE only matches a row that still has exactly this one. */
  readonly from: Extract<HopeSfvStatus, "open" | "overdue">;
  readonly to: HopeSfvStatus;
  /** The snapshot's `due_at` (ISO string) the decision was planned from. */
  readonly snapshotDueAt: string;
}

/**
 * Flip one SFV's status (called only for the watchdog's `changed===true` transitions — an `overdue`
 * re-emit with no status change writes no row, only the event re-fires).
 *
 * The snapshot this transition was planned from (`openOrOverdueSfvsForOrg`) is an unlocked read, so another
 * writer can commit between it and this write, and the UPDATE is keyed on what the plan was based on:
 * - the EXACT `from` status the plan read (`open` -> `overdue` or, past the missed boundary, `missed`; `overdue` -> `missed`),
 *   never the family. Two overlapping ticks can
 *   plan the same transition from the same snapshot; the second one's row lock wait ends on a row that is no longer
 *   `from`, so it matches nothing and does not republish the transition's event. (`completed`/`withdrawn` never
 *   match either, so a clinician's completion is never decayed over.) The family guard lives in
 *   hope-sfv-service.ts, where a withdraw or due-date change legitimately races this flip.
 * - the `due_at` the decision was planned from (`snapshotDueAt`): a reconcile that moved the due date later in
 *   between would otherwise get a decay judged against the OLD date (a false overdue/missed escalation). The
 *   comparison truncates the column to milliseconds because the snapshot went through a JS `Date`; a `due_at`
 *   written with sub-millisecond precision would otherwise never match.
 * Returns whether a row was written; `false` is a benign lost race (the next tick re-plans from a fresh
 * snapshot), and the caller must not publish the transition's event.
 */
export async function updateSfvStatus(tx: DbClient, flip: SfvStatusFlip): Promise<boolean> {
  const rows = await tx
    .update(SFV)
    .set({ status: flip.to, updatedAt: new Date() })
    .where(
      and(
        eq(SFV.id, flip.sfvId),
        eq(SFV.status, flip.from),
        sql`date_trunc('milliseconds', ${SFV.dueAt}) = ${flip.snapshotDueAt}::timestamptz`,
      ),
    )
    .returning({ id: SFV.id });
  return rows.length > 0;
}
