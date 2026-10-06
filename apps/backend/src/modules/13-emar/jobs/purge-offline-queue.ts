// apps/backend/src/modules/13-emar/jobs/purge-offline-queue.ts — the §4.8 `m13.purge-offline-queue` per-org
// worker (GAP-038 follow-up). Spec §3 (retention): `administration_offline_queue` is "purged via
// `purge-old-offline-queue` cron at 30 days post-sync".
//
// WHAT IS PURGED. Only rows with `sync_status = 'synced'` older than {@link OFFLINE_QUEUE_RETENTION_DAYS}.
// The table is the SERVER-side idempotency/audit ledger of offline-sync requests; a `synced` row's clinical
// payload already lives in `administration_record` (linked by `synced_administration_record_id`), so deleting
// the ledger row loses no clinical record. The write-audit trigger (0041) records every DELETE
// (`administration_offline_queue.delete`, `rejection_reason_detail` scrubbed), which is the purge's audit trail
// — the spec requires no separate summary event, so none is emitted.
//
// WHAT IS NEVER PURGED. `pending` (an unreconciled administration the device is still waiting on) and
// `rejected` (an open "Sync issues" workflow item — the clinician has not re-entered the administration, so the
// ledger row is the only server-side trace) rows are never deleted at any age. Deleting either would silently
// lose a clinical administration.
//
// AGE CLOCK. The table has no `synced_at` column (and this job adds none); `received_at` — when the server
// first received the request — is the nearest clock. Sync happens at or after receipt, so `received_at` can only
// make a row look OLDER than its sync: with a retention measured in weeks the worst case is a row purged a
// short while early, never a pending/rejected row (those are excluded by status, not age).
//
// BOUNDS. Batches of {@link OFFLINE_QUEUE_PURGE_BATCH_SIZE} per `withOrgContext` tx (the audit trigger writes
// one `audit_event` per deleted row, so the batch also bounds the tx), at most
// {@link OFFLINE_QUEUE_PURGE_MAX_BATCHES} per org per tick; a larger backlog drains over the next nightly ticks.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq, inArray, lt } from "drizzle-orm";

const Q = schema.administrationOfflineQueue;

/** Spec §3: purged 30 days post-sync. */
export const OFFLINE_QUEUE_RETENTION_DAYS = 30;
export const OFFLINE_QUEUE_PURGE_BATCH_SIZE = 500;
export const OFFLINE_QUEUE_PURGE_MAX_BATCHES = 20;

const MS_PER_DAY = 86_400_000;

export interface PurgeOfflineQueueDeps {
  readonly db: DbClient;
  readonly now?: () => Date;
}

export interface PurgeOfflineQueueResult {
  readonly purged: number;
}

/** Delete ONE bounded batch of synced rows older than `cutoff`; returns how many went. */
async function purgeBatch(db: DbClient, organizationId: string, cutoff: Date): Promise<number> {
  return withOrgContext(db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const candidates = await tx
      .select({ id: Q.id })
      .from(Q)
      .where(and(eq(Q.syncStatus, "synced"), lt(Q.receivedAt, cutoff)))
      .orderBy(asc(Q.receivedAt), asc(Q.id))
      .limit(OFFLINE_QUEUE_PURGE_BATCH_SIZE);
    if (candidates.length === 0) return 0;
    // The predicate is re-asserted on the DELETE: a row that flipped state between the read and the delete
    // (it cannot leave `synced`, but the guard keeps the invariant local to this statement) is never removed.
    const deleted = await tx
      .delete(Q)
      .where(
        and(
          inArray(
            Q.id,
            candidates.map((c) => c.id),
          ),
          eq(Q.organizationId, organizationId),
          eq(Q.syncStatus, "synced"),
          lt(Q.receivedAt, cutoff),
        ),
      )
      .returning({ id: Q.id });
    return deleted.length;
  });
}

/** Purge one org's synced offline-queue rows past retention. Idempotent: a re-run finds nothing left. */
export async function runPurgeOfflineQueueForOrg(
  deps: PurgeOfflineQueueDeps,
  organizationId: string,
): Promise<PurgeOfflineQueueResult> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - OFFLINE_QUEUE_RETENTION_DAYS * MS_PER_DAY);
  let purged = 0;
  for (let batch = 0; batch < OFFLINE_QUEUE_PURGE_MAX_BATCHES; batch += 1) {
    const n = await purgeBatch(deps.db, organizationId, cutoff);
    purged += n;
    if (n < OFFLINE_QUEUE_PURGE_BATCH_SIZE) break;
  }
  return { purged };
}
