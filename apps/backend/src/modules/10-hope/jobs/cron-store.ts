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
import { type DbClient, schema } from "@wardenx/db";
import type { HopeScheduleStatus, HopeSfvStatus } from "@wardenx/types";
import { and, eq, inArray } from "drizzle-orm";
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
    .where(and(eq(SCHED.organizationId, organizationId), eq(SCHED.status, "open")));
  return rows.map((r) => ({
    scheduleId: r.id,
    patientId: r.patientId,
    admissionId: r.admissionId,
    rfaKind: r.rfaKind,
    status: r.status,
    windowOpensAt: r.windowOpensAt.toISOString(),
    windowClosesAt: r.windowClosesAt.toISOString(),
    lateDeadlineAt: r.lateDeadlineAt.toISOString(),
  }));
}

/** Flip one schedule's status (called only for the watchdog's `changed===true` transitions). */
export async function updateHopeScheduleStatus(
  tx: DbClient,
  scheduleId: string,
  status: HopeScheduleStatus,
): Promise<void> {
  await tx.update(SCHED).set({ status, updatedAt: new Date() }).where(eq(SCHED.id, scheduleId));
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
    .where(and(eq(SFV.organizationId, organizationId), inArray(SFV.status, ["open", "overdue"])));
  return rows.map((r) => ({
    sfvId: r.id,
    patientId: r.patientId,
    admissionId: r.admissionId,
    triggeringAssessmentId: r.triggeringAssessmentId,
    status: r.status,
    dueAt: r.dueAt.toISOString(),
    timeZone: DEFAULT_ORG_TIME_ZONE,
  }));
}

/**
 * Flip one SFV's status (called only for the watchdog's `changed===true` transitions — an `overdue`
 * re-emit with no status change writes no row, only the event re-fires). Mirrors the exact
 * `.update(SFV).set(...)` column handling at hope-route-service-db.ts's `recordSfv` (~line 409).
 */
export async function updateSfvStatus(
  tx: DbClient,
  sfvId: string,
  status: HopeSfvStatus,
): Promise<void> {
  await tx.update(SFV).set({ status, updatedAt: new Date() }).where(eq(SFV.id, sfvId));
}
