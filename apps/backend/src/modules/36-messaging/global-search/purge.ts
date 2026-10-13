// WP 2.7b C2 (ADR-0058 "Turning OFF") - the asynchronous, batched, idempotent, resumable purge of a tenant's token rows.
// It runs while `purge_requested_at` is set, `purge_completed_at` is null AND the tenant flag is OFF (a tenant that was
// switched back ON meanwhile is not purged). Each batch is its own short tenant transaction (a crash resumes by simply
// running again). On completion, in one transaction: the tenant's build-state rows are deleted (turning back ON needs a full
// rebuild) and `purge_completed_at` is set; the write-audit trigger on `tenant_messaging_search_setting` records that update
// (who/when/before/after), which is the completion audit. The query path refuses regardless of lingering rows (C3).
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import { readTenantSearchSettingInTx } from "./tenant-setting-store";

export const PURGE_BATCH_ROWS = 5000;

export interface PurgeResult {
  readonly state: "none" | "completed" | "resumable";
  readonly deleted: number;
}

export async function purgeOrgIfRequested(
  db: DbClient,
  organizationId: string,
  opts: { readonly batchRows?: number; readonly maxBatches?: number } = {},
): Promise<PurgeResult> {
  const batchRows = opts.batchRows ?? PURGE_BATCH_ROWS;
  const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const step = await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      // FOR UPDATE for the whole step (not SHARE then UPDATE: two replicas would deadlock on the upgrade); an admin flip waits.
      const setting = await readTenantSearchSettingInTx(tx, organizationId, { lock: "update" });
      if (setting.enabled || !setting.purgeRequestedAt || setting.purgeCompletedAt) {
        return { done: true as const, n: 0, active: false };
      }
      const result = await tx.execute(sql`
        DELETE FROM message_search_token
         WHERE ctid IN (SELECT ctid FROM message_search_token
                         WHERE organization_id = ${organizationId} LIMIT ${batchRows})`);
      const n = Number(result.rowCount ?? 0);
      if (n >= batchRows) return { done: false as const, n, active: true };
      await tx.execute(
        sql`DELETE FROM message_search_index_state WHERE organization_id = ${organizationId}`,
      );
      await tx.execute(sql`
        UPDATE tenant_messaging_search_setting SET purge_completed_at = now()
         WHERE organization_id = ${organizationId} AND enabled = false
           AND purge_requested_at IS NOT NULL AND purge_completed_at IS NULL`);
      return { done: true as const, n, active: true };
    });
    deleted += step.n;
    if (!step.active) return { state: "none", deleted };
    if (step.done) return { state: "completed", deleted };
  }
  return { state: "resumable", deleted };
}
