// apps/backend/src/modules/37-ipu/jobs/lifecycle-store.ts — batch 11: the Drizzle reads/writes behind the five
// lifecycle crons (`lifecycle-workers.ts`). ORG-scoped, caller-owned `withOrgContext` tx — this file never
// opens its own tenancy envelope, and every read is RLS-filtered on top of the explicit `organization_id`.
//
// DRIZZLE TRAP (found by GAP-105): in a single-FROM query Drizzle renders column refs UNQUALIFIED, so a
// correlated subquery written with `${T.col}` refs silently binds to the INNER table (a null-binding that
// returns the wrong row, not an error). Nothing here uses a correlated subquery: every one-to-many fact is a
// real JOIN + GROUP BY, where Drizzle qualifies each column, and the test that guards it
// (`m37-lifecycle-crons.live.test.ts`) seeds two rows with DIFFERENT facts so a mis-binding changes the answer.
import { type DbClient, schema } from "@wardenx/db";
import { INSPECTION_DUE_WARN_DAYS, RESERVATION_HOLD_HOURS } from "@wardenx/inpatient";
import type { IpuAdmissionKind, IpuAdmissionState } from "@wardenx/types";
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { M37_SYSTEM_MEMBERSHIP_ID } from "../routes/system-actor";
import {
  type EndedShiftFact,
  type EquipmentInspectionFact,
  INSPECTION_OVERDUE_REPEAT_DAYS,
  NURSING_NOTE_ROLES,
  POST_CLOSE_SETTLEMENT_DAYS,
  type ReservedBedFact,
  type SettledAdmissionFact,
  type TransferringFact,
  type UnitAdmissionFact,
} from "./lifecycle-plans";

const ADM = schema.ipuAdmission;
const BED = schema.ipuBed;
const BED_EVENT = schema.ipuBedCleaningEvent;
const ASSIGN = schema.ipuBedAssignment;
const HISTORY = schema.ipuAdmissionStateHistory;
const TRANSITION = schema.ipuAdmissionTransition;
const EQUIPMENT = schema.ipuEquipment;
const SHIFT = schema.ipuShift;
const STAFF = schema.ipuStaffAssignment;
const BODY_RELEASE = schema.ipuBodyRelease;
const IRC = schema.ircEpisode;
const RESTRAINT = schema.ipuRestraintEvent;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

// ── reservation expiry ───────────────────────────────────────────────────────────────────────────────────

/**
 * `reserved` beds whose 4-hour hold has lapsed, with the live assignment + admission each was made for.
 * Pre-filtered to the beds the planner may act on (no live assignment, or its admission still `bed_assigned`)
 * so an inconsistent row the planner skips cannot occupy the per-tick cap forever.
 */
export async function expiredReservedBeds(
  tx: DbClient,
  organizationId: string,
  nowMs: number,
  limit: number,
): Promise<ReservedBedFact[]> {
  const cutoff = new Date(nowMs - RESERVATION_HOLD_HOURS * HOUR_MS);
  const rows = await tx
    .select({
      bedId: BED.id,
      unitId: BED.unitId,
      changedAt: BED.cleaningStatusChangedAt,
      assignmentId: ASSIGN.id,
      admissionId: ADM.id,
      admissionKind: ADM.kind,
      admissionState: ADM.state,
    })
    .from(BED)
    .leftJoin(ASSIGN, and(eq(ASSIGN.bedId, BED.id), isNull(ASSIGN.endedAt)))
    .leftJoin(ADM, eq(ADM.id, ASSIGN.ipuAdmissionId))
    .where(
      and(
        eq(BED.organizationId, organizationId),
        eq(BED.cleaningStatus, "reserved"),
        lt(BED.cleaningStatusChangedAt, cutoff),
        sql`(${ASSIGN.id} IS NULL OR ${ADM.state} = 'bed_assigned')`,
      ),
    )
    .orderBy(BED.cleaningStatusChangedAt)
    .limit(limit);
  return rows.map((r) => ({
    bedId: r.bedId,
    unitId: r.unitId,
    reservedAtMs: r.changedAt.getTime(),
    assignment:
      r.assignmentId && r.admissionId && r.admissionState
        ? {
            assignmentId: r.assignmentId,
            ipuAdmissionId: r.admissionId,
            admissionKind: r.admissionKind as IpuAdmissionKind,
            admissionState: r.admissionState,
          }
        : null,
  }));
}

/**
 * Release one lapsed hold: the bed `reserved → ready` (+ its `ipu_bed_cleaning_event`), the live assignment
 * ended, and the admission stepped back `bed_assigned → bed_pending` (+ its state history). Row-locks the bed
 * (and the admission) first and re-checks both states under the lock, so a confirm that won the race leaves the
 * hold alone. Returns whether this call released it.
 */
export async function releaseReservation(
  tx: DbClient,
  organizationId: string,
  plan: {
    readonly bedId: string;
    readonly assignmentId: string | null;
    readonly ipuAdmissionId: string | null;
  },
  nowMs: number,
): Promise<boolean> {
  const cutoff = new Date(nowMs - RESERVATION_HOLD_HOURS * HOUR_MS);
  const [bed] = await tx
    .select({ status: BED.cleaningStatus, changedAt: BED.cleaningStatusChangedAt })
    .from(BED)
    .where(eq(BED.id, plan.bedId))
    .for("update");
  if (!bed || bed.status !== "reserved" || bed.changedAt.getTime() >= cutoff.getTime())
    return false;

  if (plan.ipuAdmissionId) {
    const [admission] = await tx
      .select({ state: ADM.state })
      .from(ADM)
      .where(eq(ADM.id, plan.ipuAdmissionId))
      .for("update");
    if (!admission || admission.state !== "bed_assigned") return false;
    await tx
      .update(ADM)
      .set({
        state: "bed_pending",
        bedAssignedAt: null,
        updatedAt: new Date(nowMs),
        version: sql`${ADM.version} + 1`,
      })
      .where(eq(ADM.id, plan.ipuAdmissionId));
    await tx.insert(HISTORY).values({
      organizationId,
      ipuAdmissionId: plan.ipuAdmissionId,
      fromState: "bed_assigned",
      toState: "bed_pending",
      byMembershipId: M37_SYSTEM_MEMBERSHIP_ID,
      reason: "reservation_expired",
    });
  }
  if (plan.assignmentId) {
    await tx
      .update(ASSIGN)
      .set({
        endedAt: new Date(nowMs),
        unassignReason: "reservation_expired",
        updatedAt: new Date(nowMs),
      })
      .where(and(eq(ASSIGN.id, plan.assignmentId), isNull(ASSIGN.endedAt)));
  }
  await tx
    .update(BED)
    .set({
      cleaningStatus: "ready",
      cleaningStatusChangedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .where(eq(BED.id, plan.bedId));
  await tx.insert(BED_EVENT).values({
    organizationId,
    bedId: plan.bedId,
    fromStatus: "reserved",
    toStatus: "ready",
    byMembershipId: M37_SYSTEM_MEMBERSHIP_ID,
    notes: "reservation_expired",
  });
  return true;
}

// ── equipment inspection ─────────────────────────────────────────────────────────────────────────────────

/**
 * Active equipment whose inspection due date lands on an alert day for `todayLocalDate` — filtered in SQL (the
 * overdue set is unbounded and re-raises weekly, so a Node-side filter under a row cap would starve).
 * Equipment with no `next_inspection_due_date` (never inspected) is not an alert subject: the
 * `m37.equipment.inspection_current` gate already refuses to assign it.
 */
export async function equipmentOnAlertDays(
  tx: DbClient,
  organizationId: string,
  todayLocalDate: string,
  limit: number,
): Promise<EquipmentInspectionFact[]> {
  const daysUntil = sql`(${EQUIPMENT.nextInspectionDueDate} - ${todayLocalDate}::date)`;
  const warnDays = sql.join(
    INSPECTION_DUE_WARN_DAYS.map((d) => sql`${d}`),
    sql`, `,
  );
  const rows = await tx
    .select({ equipmentId: EQUIPMENT.id, dueDate: EQUIPMENT.nextInspectionDueDate })
    .from(EQUIPMENT)
    .where(
      and(
        eq(EQUIPMENT.organizationId, organizationId),
        eq(EQUIPMENT.currentStatus, "active"),
        isNotNull(EQUIPMENT.nextInspectionDueDate),
        sql`(${daysUntil} IN (${warnDays}) OR (${daysUntil} <= -1 AND ((-${daysUntil}) - 1) % ${INSPECTION_OVERDUE_REPEAT_DAYS} = 0))`,
      ),
    )
    .orderBy(EQUIPMENT.nextInspectionDueDate)
    .limit(limit);
  return rows.flatMap((r) =>
    r.dueDate ? [{ equipmentId: r.equipmentId, dueDate: r.dueDate }] : [],
  );
}

// ── nursing-note shift coverage ──────────────────────────────────────────────────────────────────────────

/** Shifts whose end falls in `(endAfterMs, endAtOrBeforeMs]`, each with its RN-equivalent assignees. */
export async function endedShiftsWithRns(
  tx: DbClient,
  organizationId: string,
  endAfterMs: number,
  endAtOrBeforeMs: number,
  limit: number,
): Promise<EndedShiftFact[]> {
  const shifts = await tx
    .select({
      shiftId: SHIFT.id,
      unitId: SHIFT.unitId,
      start: SHIFT.shiftStartAt,
      end: SHIFT.shiftEndAt,
    })
    .from(SHIFT)
    .where(
      and(
        eq(SHIFT.organizationId, organizationId),
        gt(SHIFT.shiftEndAt, new Date(endAfterMs)),
        lte(SHIFT.shiftEndAt, new Date(endAtOrBeforeMs)),
      ),
    )
    .orderBy(SHIFT.shiftEndAt)
    .limit(limit);
  if (shifts.length === 0) return [];
  const assignments = await tx
    .select({ shiftId: STAFF.shiftId, membershipId: STAFF.membershipId })
    .from(STAFF)
    .where(
      and(
        inArray(
          STAFF.shiftId,
          shifts.map((s) => s.shiftId),
        ),
        inArray(STAFF.role, [...NURSING_NOTE_ROLES]),
        inArray(STAFF.state, ["confirmed", "completed"]),
      ),
    );
  return shifts.map((s) => ({
    shiftId: s.shiftId,
    unitId: s.unitId,
    shiftStartMs: s.start.getTime(),
    shiftEndMs: s.end.getTime(),
    rnMembershipIds: assignments.filter((a) => a.shiftId === s.shiftId).map((a) => a.membershipId),
  }));
}

/** GIP/IRC admissions currently in bed in the given units. */
export async function occupyingUnitAdmissions(
  tx: DbClient,
  organizationId: string,
  unitIds: readonly string[],
  limit: number,
): Promise<UnitAdmissionFact[]> {
  if (unitIds.length === 0) return [];
  const rows = await tx
    .select({
      ipuAdmissionId: ADM.id,
      patientId: ADM.patientId,
      unitId: ADM.unitId,
      activatedAt: ADM.activatedAt,
    })
    .from(ADM)
    .where(
      and(
        eq(ADM.organizationId, organizationId),
        inArray(ADM.unitId, [...unitIds]),
        inArray(ADM.state, ["active", "transferring"]),
        isNotNull(ADM.activatedAt),
      ),
    )
    .orderBy(ADM.openedAt)
    .limit(limit);
  return rows.flatMap((r) =>
    r.unitId && r.activatedAt
      ? [
          {
            ipuAdmissionId: r.ipuAdmissionId,
            patientId: r.patientId,
            unitId: r.unitId,
            activatedAtMs: r.activatedAt.getTime(),
          },
        ]
      : [],
  );
}

// ── transfer completion ──────────────────────────────────────────────────────────────────────────────────

/** `transferring` admissions whose latest transfer began at or before `nowMs - confirmWindowMs`. */
export async function unconfirmedTransfers(
  tx: DbClient,
  organizationId: string,
  nowMs: number,
  confirmWindowMs: number,
  limit: number,
): Promise<TransferringFact[]> {
  const cutoff = new Date(nowMs - confirmWindowMs);
  const rows = await tx
    .select({
      ipuAdmissionId: ADM.id,
      initiatedAt: sql<Date | string>`max(${TRANSITION.initiatedAt})`,
    })
    .from(ADM)
    .innerJoin(TRANSITION, eq(TRANSITION.ipuAdmissionId, ADM.id))
    .where(and(eq(ADM.organizationId, organizationId), eq(ADM.state, "transferring")))
    .groupBy(ADM.id)
    .having(sql`max(${TRANSITION.initiatedAt}) <= ${cutoff}`)
    .orderBy(sql`max(${TRANSITION.initiatedAt})`)
    .limit(limit);
  return rows.map((r) => ({
    ipuAdmissionId: r.ipuAdmissionId,
    initiatedAtMs: toDate(r.initiatedAt).getTime(),
  }));
}

// ── post-close settlement ────────────────────────────────────────────────────────────────────────────────

/**
 * `discharged | transferred | deceased` admissions past T+7 with no open child row. The whole rule lives in the
 * HAVING (a blocked admission must not occupy the cap): the T+7 clock is the later of the terminal state entry
 * and — for a death — the body release closing; no non-closed IRC episode, no active restraint, and a death's
 * body release must be `closed`.
 */
export async function settledAdmissions(
  tx: DbClient,
  organizationId: string,
  nowMs: number,
  limit: number,
): Promise<SettledAdmissionFact[]> {
  const cutoff = new Date(nowMs - POST_CLOSE_SETTLEMENT_DAYS * DAY_MS);
  const stateEntry = sql`coalesce(max(${HISTORY.at}), ${ADM.updatedAt})`;
  // GREATEST ignores NULL: a stay with no body release (everything but a death) settles at its state entry.
  const settledAt = sql`greatest(${stateEntry}, ${BODY_RELEASE.closedAt})`;
  const openIrc = sql<number>`count(distinct ${IRC.id}) filter (where ${IRC.state} <> 'closed')`;
  const activeRestraints = sql<number>`count(distinct ${RESTRAINT.id}) filter (where ${RESTRAINT.state} = 'active')`;
  const rows = await tx
    .select({
      ipuAdmissionId: ADM.id,
      kind: ADM.kind,
      state: ADM.state,
      settledAt: sql<Date | string>`${settledAt}`,
      openIrc,
      activeRestraints,
      bodyReleaseState: BODY_RELEASE.state,
    })
    .from(ADM)
    .leftJoin(HISTORY, and(eq(HISTORY.ipuAdmissionId, ADM.id), eq(HISTORY.toState, ADM.state)))
    .leftJoin(BODY_RELEASE, eq(BODY_RELEASE.ipuAdmissionId, ADM.id))
    .leftJoin(IRC, eq(IRC.ipuAdmissionId, ADM.id))
    .leftJoin(RESTRAINT, eq(RESTRAINT.ipuAdmissionId, ADM.id))
    .where(
      and(
        eq(ADM.organizationId, organizationId),
        inArray(ADM.state, ["discharged", "transferred", "deceased"]),
      ),
    )
    .groupBy(ADM.id, BODY_RELEASE.id)
    .having(
      sql`${settledAt} <= ${cutoff}
        AND count(distinct ${IRC.id}) filter (where ${IRC.state} <> 'closed') = 0
        AND count(distinct ${RESTRAINT.id}) filter (where ${RESTRAINT.state} = 'active') = 0
        AND (${ADM.state} <> 'deceased' OR ${BODY_RELEASE.state} = 'closed')`,
    )
    .orderBy(sql`${settledAt}`)
    .limit(limit);
  return rows.map((r) => ({
    ipuAdmissionId: r.ipuAdmissionId,
    kind: r.kind,
    state: r.state as SettledAdmissionFact["state"],
    settledAtMs: toDate(r.settledAt).getTime(),
    openIrcEpisodes: Number(r.openIrc),
    activeRestraints: Number(r.activeRestraints),
    bodyReleaseOpen: r.state === "deceased" && r.bodyReleaseState !== "closed",
  }));
}

/**
 * Close one settled admission (optimistic on its settled state). Returns whether this call closed it; the
 * `closed` event is the caller's to publish in the same tx.
 */
export async function closeSettledAdmission(
  tx: DbClient,
  organizationId: string,
  fact: { readonly ipuAdmissionId: string; readonly state: IpuAdmissionState },
  nowMs: number,
): Promise<boolean> {
  const updated = await tx
    .update(ADM)
    .set({
      state: "closed",
      closedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
      version: sql`${ADM.version} + 1`,
    })
    .where(and(eq(ADM.id, fact.ipuAdmissionId), eq(ADM.state, fact.state)))
    .returning({ id: ADM.id });
  if (updated.length === 0) return false;
  await tx.insert(HISTORY).values({
    organizationId,
    ipuAdmissionId: fact.ipuAdmissionId,
    fromState: fact.state,
    toState: "closed",
    byMembershipId: M37_SYSTEM_MEMBERSHIP_ID,
    reason: "post_close_settlement",
  });
  return true;
}
