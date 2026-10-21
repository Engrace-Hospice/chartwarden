// M36 WP 5.7 (ADR-0089, PROPOSED), D6 - the hourly expiry sweep (`messaging.export_expiry_sweep`). For every READY export whose link has expired
// (`expires_at <= now()`, the DATABASE clock) it deletes the stored object (an object already gone is fine), then moves ready -> expired; the
// guard trigger nulls `wrapped_dek`, so even an undeleted object is unreadable. Publishes `m36.export.expired` (PHI-free). Flag-independent:
// an artefact must expire even when the feature is switched off. Keyset-paged on the job id, MAX_PAGES per org per tick like the break-glass
// sweep. A failed delete leaves the job `ready` (retried next tick) and fails the org's run after the others were attempted.
// It also lists the `approved` exports old enough that their build enqueue was lost, for the worker tick to enqueue again.
// It also fails an export stuck in `building` past EXPORT_BUILD_TIMEOUT_MINUTES (a worker that died mid-build), so it cannot sit there forever.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { HintOutboxPort } from "../message-hint-events";
import { publishExportEvent } from "./export-events";

const J = schema.messageExportJobs;

export const EXPIRY_SWEEP_BATCH = 100;
export const MAX_PAGES = 25;
export const EXPORT_BUILD_TIMEOUT_MINUTES = 30;
/** An `approved` job this old has had its build enqueued long ago: the enqueue was lost (queue flushed), so the sweep enqueues it again. */
export const EXPORT_APPROVED_REENQUEUE_MINUTES = 15;
export const EXPORT_FAIL_TIMEOUT = "EXPORT_BUILD_TIMEOUT";

/** The database half of the sweep (each call its own tenant transaction). */
export interface ExportExpiryStore {
  /** READY jobs with `expires_at <= now()` (DB clock), by id ascending, strictly after `after`. */
  dueAfter(
    organizationId: string,
    after: string | null,
    limit: number,
  ): Promise<readonly { readonly id: string; readonly artefactKey: string | null }[]>;
  /** ready -> expired (the guard nulls the wrapped key) + `m36.export.expired`; false when the job was no longer a due ready one. */
  expire(organizationId: string, jobId: string): Promise<boolean>;
  /** building -> failed for builds older than the timeout; returns how many. */
  failStuckBuilds(organizationId: string): Promise<number>;
  /** Ids of `approved` jobs decided more than EXPORT_APPROVED_REENQUEUE_MINUTES ago (DB clock), oldest first, at most `limit`. */
  staleApproved(organizationId: string, limit: number): Promise<readonly string[]>;
}

export function createExportExpiryStore(deps: {
  readonly db: DbClient;
  readonly outbox: HintOutboxPort;
}): ExportExpiryStore {
  const inTx = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(deps.db, systemOrgContext(organizationId), (tx) =>
      fn(tx as unknown as DbClient),
    );
  return {
    dueAfter: (organizationId, after, limit) =>
      inTx(organizationId, (tx) =>
        tx
          .select({ id: J.id, artefactKey: J.artefactKey })
          .from(J)
          .where(
            and(
              eq(J.organizationId, organizationId),
              eq(J.status, "ready"),
              sql`${J.expiresAt} <= now()`,
              after ? gt(J.id, after) : undefined,
            ),
          )
          .orderBy(asc(J.id))
          .limit(limit),
      ),
    expire: (organizationId, jobId) =>
      inTx(organizationId, async (tx) => {
        const rows = await tx
          .update(J)
          .set({ status: "expired" })
          .where(
            and(
              eq(J.organizationId, organizationId),
              eq(J.id, jobId),
              eq(J.status, "ready"),
              sql`${J.expiresAt} <= now()`,
            ),
          )
          .returning({ id: J.id });
        if (rows.length === 0) return false;
        await publishExportEvent(deps.outbox, tx, {
          kind: "expired",
          orgId: organizationId,
          jobId,
          at: new Date(),
        });
        return true;
      }),
    staleApproved: (organizationId, limit) =>
      inTx(organizationId, async (tx) => {
        const rows = await tx
          .select({ id: J.id })
          .from(J)
          .where(
            and(
              eq(J.organizationId, organizationId),
              eq(J.status, "approved"),
              sql`${J.decidedAt} <= now() - make_interval(mins => ${EXPORT_APPROVED_REENQUEUE_MINUTES})`,
            ),
          )
          .orderBy(asc(J.decidedAt))
          .limit(limit);
        return rows.map((r) => r.id);
      }),
    failStuckBuilds: (organizationId) =>
      inTx(organizationId, async (tx) => {
        const rows = await tx
          .update(J)
          .set({ status: "failed", failureCode: EXPORT_FAIL_TIMEOUT })
          .where(
            and(
              eq(J.organizationId, organizationId),
              eq(J.status, "building"),
              sql`${J.buildingAt} <= now() - make_interval(mins => ${EXPORT_BUILD_TIMEOUT_MINUTES})`,
            ),
          )
          .returning({ id: J.id });
        return rows.length;
      }),
  };
}

export interface ExportExpirySweepDeps {
  readonly store: ExportExpiryStore;
  /** Delete the stored object (every version). Idempotent: an already-gone object resolves. */
  readonly deleteObject: (args: {
    readonly organizationId: string;
    readonly objectKey: string;
  }) => Promise<void>;
  readonly onError?: (context: { organizationId: string; jobId: string }, error: unknown) => void;
}

export interface ExportExpirySweepResult {
  readonly expired: number;
  readonly timedOut: number;
}

export function createExportExpirySweep(deps: ExportExpirySweepDeps) {
  return {
    async expireForOrg(organizationId: string): Promise<ExportExpirySweepResult> {
      let expired = 0;
      let after: string | null = null;
      const errors: unknown[] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const due = await deps.store.dueAfter(organizationId, after, EXPIRY_SWEEP_BATCH);
        for (const job of due) {
          try {
            if (job.artefactKey) {
              await deps.deleteObject({ organizationId, objectKey: job.artefactKey });
            }
            if (await deps.store.expire(organizationId, job.id)) expired += 1;
          } catch (error) {
            errors.push(error);
            deps.onError?.({ organizationId, jobId: job.id }, error);
          }
        }
        if (due.length < EXPIRY_SWEEP_BATCH) break;
        after = due[due.length - 1]?.id ?? null;
      }
      const timedOut = await deps.store.failStuckBuilds(organizationId);
      if (errors.length > 0) {
        throw new AggregateError(errors, `export expiry sweep failed for ${errors.length} job(s)`);
      }
      return { expired, timedOut };
    },
    /** Approved exports whose build job was probably lost (see EXPORT_APPROVED_REENQUEUE_MINUTES); the caller enqueues each. */
    staleApprovedForOrg: (organizationId: string) =>
      deps.store.staleApproved(organizationId, EXPIRY_SWEEP_BATCH),
  };
}

export type ExportExpirySweep = ReturnType<typeof createExportExpirySweep>;
