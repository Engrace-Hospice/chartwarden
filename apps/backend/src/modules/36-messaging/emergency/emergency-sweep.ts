// apps/backend/src/modules/36-messaging/emergency/emergency-sweep.ts - ADR-0106 B: the minute sweep that keeps an emergency loud and tells the
// sender when it is not answered. One org per call, nothing stored beyond the alerts themselves:
//   - RE-ALARM: every recipient who has not acknowledged and whose emergency is under an hour old gets the alarm for the current tick (whole
//     minutes since the send). The alert id converges on `emergency:<id>:<user>:<tick>`, so two sweeps in the same minute, or a retried tick,
//     raise nothing twice; stopping is simply "acknowledged" (the row leaves the query) or "an hour passed".
//   - ESCALATION: once the 15-minute deadline passed with somebody still unacknowledged, ONE `m36.emergency.escalated` alert goes to the sender
//     and the supervisors (id `emergency-escalated:<id>`: repeated ticks converge on it).
// The sweep is the SERVER's safety net (an OS push is never an SLA): it runs from the database, with no timer to lose, so a flushed Redis or a
// restarted worker only delays it by a tick. A tenant with the flag off is skipped (the alarms stop; turning it on resumes them).
import type { DbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { withOrgContext } from "@chartwarden/tenancy";
import { EMERGENCY_REALARM_WINDOW_MINUTES } from "@chartwarden/types";
import { sql } from "drizzle-orm";
import { alarmTick, emergencyAlarm, emergencyEscalation } from "./emergency-alert";

/** Bounds one org's work per tick; the next tick takes the rest (ponytail: raise if a tenant ever has >2000 open alarms at once). */
export const EMERGENCY_SWEEP_LIMIT = 2000;

export interface EmergencySweepSummary {
  readonly alarms: number;
  readonly escalations: number;
  readonly failed: number;
}

export interface EmergencySweepDeps {
  readonly db: DbClient;
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly alerts: Pick<AlertEmitter, "emit">;
  readonly now?: () => Date;
}

interface PendingRow extends Record<string, unknown> {
  emergency_id: string;
  channel_id: string;
  message_id: string;
  user_id: string;
  created_at: Date | string;
}
interface OverdueRow extends Record<string, unknown> {
  emergency_id: string;
  channel_id: string;
  message_id: string;
  author_user_id: string;
  pending: string | number;
}

const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

export async function sweepEmergenciesForOrg(
  deps: EmergencySweepDeps,
  orgId: string,
): Promise<EmergencySweepSummary> {
  if (!(await deps.isEnabled(orgId))) return { alarms: 0, escalations: 0, failed: 0 };
  const now = (deps.now ?? (() => new Date()))();
  const { pending, overdue } = await withOrgContext(
    deps.db,
    { organizationId: orgId, userId: "" },
    async (tx) => {
      const p = await tx.execute<PendingRow>(sql`
        SELECT e.id AS emergency_id, e.channel_id, e.message_id, r.user_id, e.created_at
          FROM message_emergency e
          JOIN message_emergency_recipient r ON r.organization_id = e.organization_id AND r.emergency_id = e.id
          JOIN message m ON m.organization_id = e.organization_id AND m.id = e.message_id AND m.deleted_at IS NULL
          JOIN "user" u ON u.id = r.user_id AND u.status = 'active'
         WHERE e.organization_id = ${orgId}::uuid AND r.acknowledged_at IS NULL
           AND e.created_at > now() - make_interval(mins => ${EMERGENCY_REALARM_WINDOW_MINUTES})
         ORDER BY e.created_at, r.user_id
         LIMIT ${EMERGENCY_SWEEP_LIMIT}`);
      const o = await tx.execute<OverdueRow>(sql`
        SELECT e.id AS emergency_id, e.channel_id, e.message_id, e.created_by AS author_user_id, count(*) AS pending
          FROM message_emergency e
          JOIN message_emergency_recipient r ON r.organization_id = e.organization_id AND r.emergency_id = e.id
          JOIN message m ON m.organization_id = e.organization_id AND m.id = e.message_id AND m.deleted_at IS NULL
         WHERE e.organization_id = ${orgId}::uuid AND r.acknowledged_at IS NULL
           AND e.deadline_at <= now()
           AND e.created_at > now() - make_interval(mins => ${EMERGENCY_REALARM_WINDOW_MINUTES})
         GROUP BY e.id, e.channel_id, e.message_id, e.created_by
         LIMIT ${EMERGENCY_SWEEP_LIMIT}`);
      return { pending: p.rows, overdue: o.rows };
    },
  );

  const totals = { alarms: 0, escalations: 0, failed: 0 };
  for (const row of pending) {
    const tick = alarmTick(asDate(row.created_at), now);
    if (tick < 1) continue; // tick 0 is the outbox consumer's first alarm
    try {
      await deps.alerts.emit(
        orgId,
        emergencyAlarm({
          emergencyId: row.emergency_id,
          channelId: row.channel_id,
          messageId: row.message_id,
          recipientUserId: row.user_id,
          tick,
        }),
      );
      totals.alarms += 1;
    } catch {
      totals.failed += 1; // the next tick is the retry; the failure fails the job so it is visible
    }
  }
  for (const row of overdue) {
    try {
      await deps.alerts.emit(
        orgId,
        emergencyEscalation({
          emergencyId: row.emergency_id,
          channelId: row.channel_id,
          messageId: row.message_id,
          authorUserId: row.author_user_id,
          pending: Number(row.pending),
        }),
      );
      totals.escalations += 1;
    } catch {
      totals.failed += 1;
    }
  }
  return totals;
}
