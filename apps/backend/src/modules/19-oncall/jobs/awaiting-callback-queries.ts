// apps/backend/src/modules/19-oncall/jobs/awaiting-callback-queries.ts — the two reads `callback-sla.cron` and
// `awaiting-callback-timeout.cron` share. `triage_call` has no "entered awaiting_callback at" column (§3.3);
// the instant is the latest `triage_call_state_history` row whose `to_state` is `awaiting_callback` — the
// append-only record of every entry, so a call that resumed and waited again is judged from its LATEST wait.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { MAX_TRIAGE_ITEMS_PER_ORG_PER_TICK } from "./triage-cron-common";

const CALL = schema.triageCall;
const HISTORY = schema.triageCallStateHistory;

/** SQL for the latest entry into `awaiting_callback` (ordering/filtering only — never read back as a value:
 *  the driver's timestamp representation of a raw `sql` expression is not the typed `Date`). */
const ENTERED_AWAITING_SQL = sql`(SELECT max(h.transitioned_at) FROM triage_call_state_history h WHERE h.triage_call_id = ${CALL.id} AND h.to_state = 'awaiting_callback')`;

/** The instant `callId` last entered `awaiting_callback`, or null when no history row records it. */
export async function enteredAwaitingCallbackAt(
  tx: DbClient,
  organizationId: string,
  callId: string,
): Promise<Date | null> {
  const [row] = await tx
    .select({ at: HISTORY.transitionedAt })
    .from(HISTORY)
    .where(
      and(
        eq(HISTORY.organizationId, organizationId),
        eq(HISTORY.triageCallId, callId),
        eq(HISTORY.toState, "awaiting_callback"),
      ),
    )
    .orderBy(desc(HISTORY.transitionedAt))
    .limit(1);
  return row?.at ?? null;
}

/**
 * The org's `awaiting_callback` call ids, longest-waiting first (so a backlog beyond the per-tick bound
 * drains the most overdue calls first). `extra` narrows further (the SLA cron drops already-paged waits).
 */
export async function awaitingCallbackCallIds(
  tx: DbClient,
  organizationId: string,
  extra?: SQL,
): Promise<readonly string[]> {
  const rows = await tx
    .select({ id: CALL.id })
    .from(CALL)
    .where(and(eq(CALL.organizationId, organizationId), eq(CALL.state, "awaiting_callback"), extra))
    .orderBy(sql`${ENTERED_AWAITING_SQL} asc nulls first`, CALL.id)
    .limit(MAX_TRIAGE_ITEMS_PER_ORG_PER_TICK);
  return rows.map((r) => r.id);
}

/** SQL: this wait has NOT been paged yet (never paged, or last paged before the latest entry). */
export const NOT_YET_PAGED_THIS_WAIT: SQL = sql`(${CALL.callbackSlaBreachedAt} IS NULL OR ${CALL.callbackSlaBreachedAt} < ${ENTERED_AWAITING_SQL})`;
