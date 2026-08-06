// apps/backend/src/bootstrap/processing-log.ts — binds a ProcessingLogPort-shaped adapter over the
// M1-owned `processing_log` table (WX-PR-014). Every §4.8 BullMQ worker opens its process() with the
// `already_processed` short-circuit this port answers; until this bound, EVERY M30 work-queue job threw
// M30WorkerPortUnbound before it could do anything (the port had no accessor at all, not just an unbound
// thunk — the table itself did not exist prior to migration 0185).
//
// Runs inside whichever tx the caller already opened (the worker rebuilds its ports over the per-job
// `withOrgContext` tx, same as the other M30 repos) — this adapter takes a `DbClient` and never opens its
// own transaction, so it composes correctly with that per-job envelope.
//
// M1 (this file's module) may not import a feature-module package (`@wardenx/quality` is M30-owned, per
// `architecture/module-manifest.ts` dependsOn) — so the return type is a LOCAL structural mirror of
// `@wardenx/quality`'s `ProcessingLogPort`, not an import of it. M30's own `M30WorkerDeps.processingLogFactory`
// field carries the real `ProcessingLogPort` type; this function's return type is structurally assignable to
// it (verified at that call site, not here).
import { type DbClient, schema } from "@wardenx/db";
import { eq } from "drizzle-orm";

/** Structural mirror of `@wardenx/quality`'s `ProcessingLogPort` — see the module boundary note above. */
interface ProcessingLogPortShape {
  isProcessed(jobId: string): Promise<boolean>;
  markProcessed(jobId: string, summary: Record<string, unknown>): Promise<void>;
}

/**
 * Build the `ProcessingLogPort` over `processing_log` (org RLS applies via the caller's tx context).
 * `organizationId` + `queueName` are bound at construction time — the port's own `markProcessed(jobId,
 * summary)` signature carries neither (the four processors' summaries are outcome-shaped, not envelope
 * metadata), so each per-job port rebuild closes over the job's known org + the worker's fixed queue name.
 */
export function buildProcessingLogPort(
  db: DbClient,
  organizationId: string,
  queueName: string,
): ProcessingLogPortShape {
  return {
    async isProcessed(jobId) {
      const [row] = await db
        .select({ jobId: schema.processingLog.jobId })
        .from(schema.processingLog)
        .where(eq(schema.processingLog.jobId, jobId))
        .limit(1);
      return row !== undefined;
    },
    async markProcessed(jobId, summary) {
      await db
        .insert(schema.processingLog)
        .values({ jobId, organizationId, queueName, outcome: summary })
        .onConflictDoNothing();
    },
  };
}
