// apps/backend/src/modules/16-bereavement/routes/closure-settlement.ts — ADR-0109 review follow-up.
//
// ONE helper every closure writer calls, on the closure's own transaction, BEFORE the closure's counts are frozen and BEFORE the discharge
// summary is built: the 13-month cron close, `cosignClose` and the post-creation patient-opt-out cascade. The miss crons only look at
// ACTIVE plans, so a `scheduled` outreach row or assessment checkpoint left on a closed plan is stranded forever, and M30's CoP denominator
// (which counts `scheduled`) would count it for ever. A closure therefore settles everything the plan still holds as `scheduled`:
//   - already DUE (`due_at < at`) -> `missed`: the program owed it and never made it (the d390 closeout letter, still inside its grace window
//     when the 13-month close fires, is the common case). The summary reports it missed and the closure's missed count includes it.
//   - still in the FUTURE -> `cancelled`: the program ended before it was owed (the existing semantics of every closure).
// `pastDue: "cancelled"` is for the exit where the family itself removed the obligation (the patient-level opt-out cascade): M30's
// denominator excludes `cancelled` precisely because an opt-out removes the obligation rather than failing it.
// Direct row updates, not the miss transition: a closing plan raises no `outreach_missed` event and no overdue alert for what it is settling.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, lt, sql } from "drizzle-orm";

const OUTREACH = schema.bereavementOutreach;
const TASK = schema.bereavementAssessmentTask;

export interface ClosureSettlement {
  readonly missedOutreach: number;
  readonly cancelledOutreach: number;
  readonly missedTasks: number;
  readonly cancelledTasks: number;
}

export async function settleOutstandingForClosure(
  tx: DbClient,
  input: {
    readonly planId: string;
    readonly at: Date;
    /** Recorded on each cancelled outreach row (audit-denylisted prose; a short fixed phrase). */
    readonly cancelReason: string;
    /** What an already-due, never-attempted row becomes. Default `missed`. */
    readonly pastDue?: "missed" | "cancelled";
  },
): Promise<ClosureSettlement> {
  const { planId, at, cancelReason } = input;
  const pastDueStatus = input.pastDue ?? "missed";
  const cancelOutreach = {
    status: "cancelled" as const,
    cancelledAt: at,
    cancellationReasonRedacted: cancelReason,
    version: sql`${OUTREACH.version} + 1`,
    updatedAt: at,
  };

  const pastDueOutreach = await tx
    .update(OUTREACH)
    .set(
      pastDueStatus === "missed"
        ? { status: "missed" as const, version: sql`${OUTREACH.version} + 1`, updatedAt: at }
        : cancelOutreach,
    )
    .where(
      and(eq(OUTREACH.planId, planId), eq(OUTREACH.status, "scheduled"), lt(OUTREACH.dueAt, at)),
    )
    .returning({ id: OUTREACH.id });
  const futureOutreach = await tx
    .update(OUTREACH)
    .set(cancelOutreach)
    .where(and(eq(OUTREACH.planId, planId), eq(OUTREACH.status, "scheduled")))
    .returning({ id: OUTREACH.id });

  const taskSet = (status: "missed" | "cancelled") => ({
    status,
    version: sql`${TASK.version} + 1`,
    updatedAt: at,
  });
  const pastDueTasks = await tx
    .update(TASK)
    .set(taskSet(pastDueStatus))
    .where(and(eq(TASK.planId, planId), eq(TASK.status, "scheduled"), lt(TASK.dueAt, at)))
    .returning({ id: TASK.id });
  const futureTasks = await tx
    .update(TASK)
    .set(taskSet("cancelled"))
    .where(and(eq(TASK.planId, planId), eq(TASK.status, "scheduled")))
    .returning({ id: TASK.id });

  return {
    missedOutreach: pastDueStatus === "missed" ? pastDueOutreach.length : 0,
    cancelledOutreach:
      futureOutreach.length + (pastDueStatus === "cancelled" ? pastDueOutreach.length : 0),
    missedTasks: pastDueStatus === "missed" ? pastDueTasks.length : 0,
    cancelledTasks: futureTasks.length + (pastDueStatus === "cancelled" ? pastDueTasks.length : 0),
  };
}
