// GAP-052 — M17 §4.8 `reassignment-scan` (PTO approved → `m17.reassignment_needed`) and
// `caregiver-reminder` (24h-out opted-in visit → `m17.caregiver_reminder_due`), as transaction-level
// helpers over the caller's org-scoped tx. The route backend (`approveTimeOff`) and the org-explicit
// automation seams (`scanTimeOffReassignmentsForOrg`, `emitCaregiverRemindersForOrg`) both call them, so
// the approval path and the cron backstop share ONE rule.
//
// Bounded (every select carries a limit) and idempotent: a visit is flagged at most once per approved
// time_off (`visit.reassignment_flagged_time_off_id`, mig 0350) and reminded at most once
// (`visit.caregiver_reminder_sent_at`), each stamped in the SAME tx as the outbox publish.
import { type DbClient, schema } from "@wardenx/db";
import { and, count, eq, gt, isNull, lt, lte, sql } from "drizzle-orm";

const V = schema.visit;
const TO = schema.timeOff;

export const REASSIGNMENT_SCAN_VISIT_LIMIT = 500;
export const REASSIGNMENT_SCAN_TIME_OFF_LIMIT = 100;
/** §4.8 — the reminder fires for opted-in visits starting within this many hours. */
export const CAREGIVER_REMINDER_LEAD_HOURS = 24;
export const CAREGIVER_REMINDER_BATCH_LIMIT = 500;
/**
 * The opt-in is a boolean on `visit` (the channel lives in M22's consent layer, D15, not on any M17 row), so
 * M17 emits the conservative channel — email — and M22/M36 resolve the real one at delivery.
 */
export const CAREGIVER_REMINDER_DEFAULT_CHANNEL = "email";

const MS_PER_HOUR = 3_600_000;

export type ReassignmentEmit = (
  tx: DbClient,
  orgId: string,
  eventName: string,
  aggregateKind: string,
  aggregateId: string,
  payload: Record<string, unknown>,
) => Promise<void>;

export interface PtoWindow {
  readonly id?: string;
  readonly membershipId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/** Published, still-upcoming visits assigned to the clinician that overlap the window. */
function publishedInWindow(orgId: string, pto: PtoWindow, now: Date) {
  return and(
    eq(V.organizationId, orgId),
    eq(V.assignedMembershipId, pto.membershipId),
    eq(V.status, "published"),
    lt(V.scheduledStartedAt, pto.endsAt),
    gt(V.scheduledEndedAt, pto.startsAt),
    gt(V.scheduledEndedAt, now),
  );
}

/** The advisory count of published visits a PTO window overlaps (drives `conflictingVisitCount`). */
export async function countPublishedVisitsInWindow(
  tx: DbClient,
  orgId: string,
  pto: PtoWindow,
  now: Date,
): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(V)
    .where(publishedInWindow(orgId, pto, now));
  return Number(row?.n ?? 0);
}

/**
 * Flag every not-yet-flagged published visit inside an APPROVED time_off window: one
 * `m17.reassignment_needed` (reason `pto_approved`) per visit plus the idempotency stamp. Returns the
 * number newly flagged (0 on a replay).
 */
export async function flagReassignmentsForTimeOff(
  tx: DbClient,
  orgId: string,
  emit: ReassignmentEmit,
  pto: PtoWindow & { readonly id: string },
  now: Date,
): Promise<number> {
  const visits = await tx
    .select({ id: V.id, serviceDate: V.serviceDate })
    .from(V)
    .where(
      and(
        publishedInWindow(orgId, pto, now),
        sql`${V.reassignmentFlaggedTimeOffId} IS DISTINCT FROM ${pto.id}`,
      ),
    )
    .orderBy(V.scheduledStartedAt)
    .limit(REASSIGNMENT_SCAN_VISIT_LIMIT);
  for (const v of visits) {
    await emit(tx, orgId, "m17.reassignment_needed", "visit", v.id, {
      visitId: v.id,
      affectedMembershipId: pto.membershipId,
      reason: "pto_approved",
    });
    await tx
      .update(V)
      .set({ reassignmentFlaggedTimeOffId: pto.id, reassignmentFlaggedAt: now })
      .where(and(eq(V.id, v.id), eq(V.serviceDate, v.serviceDate)));
  }
  return visits.length;
}

/**
 * Cron backstop: approved, not-yet-ended time-offs that still have an unflagged published visit in their
 * window (the approval path flags at most {@link REASSIGNMENT_SCAN_VISIT_LIMIT} per time_off, and visits
 * published AFTER the approval land here too), each flagged via {@link flagReassignmentsForTimeOff}.
 */
export async function sweepApprovedTimeOffReassignments(
  tx: DbClient,
  orgId: string,
  emit: ReassignmentEmit,
  now: Date,
): Promise<{ timeOffsScanned: number; visitsFlagged: number }> {
  const pending = await tx
    .select({
      id: TO.id,
      membershipId: TO.membershipId,
      startsAt: TO.startsAt,
      endsAt: TO.endsAt,
    })
    .from(TO)
    .where(
      and(
        eq(TO.organizationId, orgId),
        eq(TO.approvalState, "approved"),
        gt(TO.endsAt, now),
        sql`EXISTS (SELECT 1 FROM visit v
          WHERE v.organization_id = ${TO.organizationId}
            AND v.assigned_membership_id = ${TO.membershipId}
            AND v.status = 'published'
            AND v.scheduled_started_at < ${TO.endsAt}
            AND v.scheduled_ended_at > ${TO.startsAt}
            AND v.scheduled_ended_at > ${now.toISOString()}::timestamptz
            AND v.reassignment_flagged_time_off_id IS DISTINCT FROM ${TO.id})`,
      ),
    )
    .orderBy(TO.startsAt)
    .limit(REASSIGNMENT_SCAN_TIME_OFF_LIMIT);
  let visitsFlagged = 0;
  for (const t of pending) {
    visitsFlagged += await flagReassignmentsForTimeOff(tx, orgId, emit, t, now);
  }
  return { timeOffsScanned: pending.length, visitsFlagged };
}

/**
 * §4.8 `caregiver-reminder`: published, opted-in visits starting within the next
 * {@link CAREGIVER_REMINDER_LEAD_HOURS}h that have not been reminded — one `m17.caregiver_reminder_due`
 * each, stamping `caregiver_reminder_sent_at` in the same tx. Returns the number emitted.
 */
export async function emitDueCaregiverReminders(
  tx: DbClient,
  orgId: string,
  emit: ReassignmentEmit,
  now: Date,
): Promise<number> {
  const horizon = new Date(now.getTime() + CAREGIVER_REMINDER_LEAD_HOURS * MS_PER_HOUR);
  const due = await tx
    .select({
      id: V.id,
      patientId: V.patientId,
      serviceDate: V.serviceDate,
      scheduledStartedAt: V.scheduledStartedAt,
    })
    .from(V)
    .where(
      and(
        eq(V.organizationId, orgId),
        eq(V.status, "published"),
        eq(V.caregiverReminderOptIn, true),
        isNull(V.caregiverReminderSentAt),
        gt(V.scheduledStartedAt, now),
        lte(V.scheduledStartedAt, horizon),
      ),
    )
    .orderBy(V.scheduledStartedAt)
    .limit(CAREGIVER_REMINDER_BATCH_LIMIT);
  for (const v of due) {
    await emit(tx, orgId, "m17.caregiver_reminder_due", "visit", v.id, {
      visitId: v.id,
      patientId: v.patientId,
      channel: CAREGIVER_REMINDER_DEFAULT_CHANNEL,
      scheduledStartedAt: v.scheduledStartedAt.toISOString(),
    });
    await tx
      .update(V)
      .set({ caregiverReminderSentAt: now })
      .where(and(eq(V.id, v.id), eq(V.serviceDate, v.serviceDate)));
  }
  return due.length;
}
