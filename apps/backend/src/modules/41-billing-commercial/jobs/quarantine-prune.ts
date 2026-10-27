// apps/backend/src/modules/41-billing-commercial/jobs/quarantine-prune.ts - weekly retention prune of RESOLVED ack-quarantine rows (#824).
//
// `commercial_ack_quarantine` only grows: every held or malformed acknowledgment leaves a row, and a resolved one (applied, or abandoned
// with its m41.claim.ack_abandoned event) is history. This deletes a resolved row once it is older than the retention horizon.
//   - never an UNRESOLVED row (still held, or `malformed` awaiting review): the WHERE needs resolved_at, and migration 1286's trigger
//     refuses the app role an unresolved delete even if this code were wrong.
//   - the horizon is measured from `resolved_at`, 180 days: far past the 45-day poll cutoff, so a redelivered event cannot meet a
//     pruned row while its stream is still polled (a late redelivery would at worst re-quarantine and re-resolve it).
//   - tenant-safe: one `withOrgContext` per active org (RLS applies) plus an explicit organization filter; bounded per tick.
//   - every delete is audited by the table's write-audit trigger (ids and codes, no body). PHI-free log: counts only.
//   - `clearinghouse_interchange_number` (M23) is deliberately NOT pruned here: the app role has no DELETE on it (migration 1281) and
//     the memo must outlive any redelivery window; revisit with its owner.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { M41_CRON_QUEUES, M41_JOB_SCHEDULES } from "./queues";

export const QUARANTINE_RETENTION_DAYS = 180;
const DAY_MS = 86_400_000;
/** Rows deleted per statement, and statements per org per tick (a backlog drains over several weeks rather than in one long lock). */
export const PRUNE_BATCH_SIZE = 500;
export const PRUNE_MAX_BATCHES_PER_ORG = 20;

export interface QuarantinePruneDeps {
  readonly db: DbClient;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly now?: () => Date;
  readonly log?: (event: {
    readonly event: string;
    readonly count?: number;
    readonly code?: string;
  }) => void;
}

async function pruneOrg(
  deps: QuarantinePruneDeps,
  organizationId: string,
  cutoff: Date,
): Promise<number> {
  const Q = schema.commercialAckQuarantine;
  let deleted = 0;
  for (let i = 0; i < PRUNE_MAX_BATCHES_PER_ORG; i += 1) {
    const rows = await withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
      const due = await tx
        .select({ id: Q.id })
        .from(Q)
        .where(
          and(
            eq(Q.organizationId, organizationId),
            isNotNull(Q.resolvedAt),
            lt(Q.resolvedAt, cutoff),
          ),
        )
        .limit(PRUNE_BATCH_SIZE);
      if (due.length === 0) return 0;
      const gone = await tx
        .delete(Q)
        .where(
          and(
            eq(Q.organizationId, organizationId),
            inArray(
              Q.id,
              due.map((r) => r.id),
            ),
          ),
        )
        .returning({ id: Q.id });
      return gone.length;
    });
    deleted += rows;
    if (rows < PRUNE_BATCH_SIZE) break;
  }
  return deleted;
}

/** The cron body. Throws after every org ran when any failed (BullMQ retries; the DLQ alert fires). Returns the rows deleted. */
export async function runQuarantinePrune(deps: QuarantinePruneDeps): Promise<number> {
  const cutoff = new Date(
    (deps.now ?? (() => new Date()))().getTime() - QUARANTINE_RETENTION_DAYS * DAY_MS,
  );
  let total = 0;
  const failures: string[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      total += await pruneOrg(deps, organizationId, cutoff);
    } catch (err) {
      failures.push(`org ${organizationId}: ${err instanceof Error ? err.name : "failed"}`);
    }
  }
  deps.log?.({ event: "ack.quarantine_pruned", count: total });
  if (failures.length > 0) throw new Error(`quarantine prune failed: ${failures.join("; ")}`);
  return total;
}

export function registerM41QuarantinePruneWorker(
  connection: ConnectionOptions,
  deps: QuarantinePruneDeps,
): Worker {
  return new Worker(M41_CRON_QUEUES.quarantinePrune, async () => runQuarantinePrune(deps), {
    connection,
    concurrency: 1,
  });
}

export async function scheduleM41QuarantinePrune(connection: ConnectionOptions): Promise<Queue[]> {
  const queue = new Queue(M41_CRON_QUEUES.quarantinePrune, { connection });
  await queue.add(
    "scheduled",
    {},
    { repeat: { pattern: M41_JOB_SCHEDULES.quarantinePrune }, removeOnComplete: true },
  );
  return [queue];
}
