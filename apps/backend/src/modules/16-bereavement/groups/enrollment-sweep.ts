// apps/backend/src/modules/16-bereavement/groups/enrollment-sweep.ts — ADR-0109 D10 (PR 3): the nightly lapsed-enrollment pass.
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";

/**
 * ADR-0109 D10 (PR 3) — the nightly pass (inside `m16-close-13mo`): withdraw every live enrollment whose contact has left the program (an opt-out,
 * a closed plan, a contact that is no longer active). A PAUSED plan keeps its enrollments (a pause stops outreach; it does not end the program), it
 * only cannot enroll or record new attendance until it resumes. Set-based, one statement per org; idempotent.
 */
export async function withdrawLapsedGroupEnrollments(tx: DbClient, at: Date): Promise<number> {
  const rows = await tx.execute(sql`
    UPDATE bereavement_support_group_enrollment e
       SET status = 'withdrawn',
           withdrawn_reason = CASE WHEN p.status NOT IN ('active', 'paused') THEN 'plan_closed' ELSE 'opted_out' END,
           withdrawn_at = ${at.toISOString()}::timestamptz,
           version = e.version + 1,
           updated_at = now()
      FROM bereaved_contact c
      JOIN bereavement_plan p ON p.id = c.plan_id
     WHERE e.status = 'enrolled' AND c.id = e.bereaved_contact_id
       AND NOT (c.status = 'active' AND p.status IN ('active', 'paused') AND NOT EXISTS (
             SELECT 1 FROM bereavement_opt_out o
              WHERE o.bereaved_contact_id = c.id AND o.rescinded_at IS NULL
                AND o.opt_out_kind IN ('full', 'pause_temporarily')))
    RETURNING e.id`);
  return (rows as unknown as { rowCount: number | null }).rowCount ?? 0;
}
