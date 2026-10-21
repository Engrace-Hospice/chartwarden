// apps/backend/src/modules/22-documents/workers/retention-rotation-worker.ts — the §4.8 `retention-rotation` cron
// (GAP-141; M22 spec §8.6 / D9): the `intake_artifact` disposition + 30-day sweep.
//
// A raw intake upload (and its classifier/extraction byproducts) is kept for `retentionDays` (default 30, a
// tenant may tighten, never loosen) after the batch's final disposition. What happens next depends on whether the
// extraction fed the chart:
//
//   WRITEBACK OCCURRED  — the batch is `writeback_complete` and at least one reviewer decision was an approval
//                         (`approve` / `approve_with_edit`). The source document is PROMOTED from `intake_artifact`
//                         to `clinical_record` (it now participates in the patient's clinical-record retention).
//                         Promotion is non-destructive, idempotent (it only touches a row still in
//                         `intake_artifact`) and is done here.
//   NO WRITEBACK        — the artifacts are DUE FOR DESTRUCTION. The worker REPORTS them (one
//                         `document.retention_destruction_pending` alert per org per tick, the §4.9 compliance-officer
//                         alert) and deletes nothing: see below.
//
// WHY THE ERASE HALF IS A REPORT, NOT A DELETE (what is missing, exactly). Destroying PHI is gated in this system by
// an M4 destruction CERTIFICATE (issued, approved by a compliance officer, and executed by the privileged
// `chartwarden_destruction` role through the registered `documents` eraser — `erasers/document-eraser.ts`, which is
// PATIENT-scoped and DEK-shreds first). There is no seam by which M22 can request or auto-approve a certificate, and
// the eraser has no batch-scoped entry point for unmatched (patient-less) intake. Deleting from a cron with the
// application role would route around the very approval the destruction workflow exists to enforce, and it cannot be
// proven correct without the live destruction-role stack. So the sweep surfaces the exact set that is due and the
// compliance officer's certificate (or a future policy-approved batch eraser) removes it. Legal-held documents are
// never reported as due.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";

export const M22_RETENTION_ROTATION_QUEUE = "documents.retention_rotation";
/** Daily 03:00 UTC (the spec says org-TZ; the platform cron runs one UTC tick and sweeps every org). */
export const M22_RETENTION_ROTATION_SCHEDULE = "0 3 * * *";
export const M22_RETENTION_ROTATION_PLATFORM_JOB_ID = "m22.retention_rotation";
/** The platform default (and the loosest a tenant may configure) for the post-disposition retention window. */
export const INTAKE_ARTIFACT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
/** Terminal dispositions the §8.6 clock starts from (`disposition_at` is set exactly then, DB CHECK). */
const DISPOSED_STATUSES = ["writeback_complete", "discarded", "split_resolved_no_split"] as const;

const BATCH = schema.intakeUploadBatches;
const DOC = schema.documents;
const REVIEW = schema.extractionReviews;
const DECISION = schema.extractionDecisions;
const HOLD = schema.documentLegalHold;

export interface RetentionRotationOutcome {
  readonly promoted: number;
  /** Batches past retention with no writeback and no legal hold: awaiting a destruction certificate. */
  readonly destructionPending: number;
  readonly oldestPendingDispositionAt: string | null;
}

export interface RetentionPendingAlert {
  readonly organizationId: string;
  readonly retentionClass: "intake_artifact";
  readonly destructionPending: number;
  readonly oldestDispositionAt: string;
}

export interface RetentionRotationDeps {
  readonly db: DbClient;
  /** Best-effort §4.9 `document.retention_destruction_pending` alert; a throw never fails the tick. */
  readonly onDestructionPending?: (alert: RetentionPendingAlert) => Promise<void> | void;
  readonly now?: () => Date;
  readonly retentionDays?: number;
}

/** One org's promote-or-report pass. */
export async function rotateIntakeRetentionForOrg(
  deps: RetentionRotationDeps,
  organizationId: string,
): Promise<RetentionRotationOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  // A tenant may TIGHTEN to as little as 7 days, never loosen past the platform floor of 30.
  const days = Math.min(Math.max(deps.retentionDays ?? INTAKE_ARTIFACT_RETENTION_DAYS, 7), 30);
  const cutoff = new Date(now.getTime() - days * DAY_MS);

  const outcome = await withOrgContext(
    deps.db,
    { organizationId, userId: "" },
    async (tx): Promise<RetentionRotationOutcome> => {
      const due = await tx
        .select({
          id: BATCH.id,
          status: BATCH.status,
          initialDocumentId: BATCH.initialDocumentId,
          dispositionAt: BATCH.dispositionAt,
        })
        .from(BATCH)
        .where(
          and(
            inArray(BATCH.status, [...DISPOSED_STATUSES]),
            lte(BATCH.dispositionAt, cutoff),
            // Only batches whose source document is still in the intake class need any action.
            sql`EXISTS (SELECT 1 FROM ${DOC} WHERE ${DOC.id} = ${BATCH.initialDocumentId}
                          AND ${DOC.retentionClass} = 'intake_artifact')`,
          ),
        );
      if (due.length === 0)
        return { promoted: 0, destructionPending: 0, oldestPendingDispositionAt: null };

      // Which of them fed the chart: at least one approving decision on a review of the batch.
      const approved = await tx
        .selectDistinct({ batchId: REVIEW.intakeUploadBatchId })
        .from(DECISION)
        .innerJoin(REVIEW, eq(REVIEW.id, DECISION.extractionReviewId))
        .where(
          and(
            inArray(
              REVIEW.intakeUploadBatchId,
              due.map((b) => b.id),
            ),
            inArray(DECISION.decision, ["approve", "approve_with_edit"]),
          ),
        );
      const wroteBack = new Set(approved.map((r) => r.batchId));

      const toPromote = due.filter((b) => b.status === "writeback_complete" && wroteBack.has(b.id));
      let promoted = 0;
      if (toPromote.length > 0) {
        const res = await tx
          .update(DOC)
          .set({ retentionClass: "clinical_record" })
          .where(
            and(
              inArray(
                DOC.id,
                toPromote.map((b) => b.initialDocumentId),
              ),
              eq(DOC.retentionClass, "intake_artifact"),
            ),
          )
          .returning({ id: DOC.id });
        promoted = res.length;
      }

      // Everything else past retention is destruction-pending — unless a legal hold keeps it.
      const promotedIds = new Set(toPromote.map((b) => b.id));
      const candidates = due.filter((b) => !promotedIds.has(b.id) && !wroteBack.has(b.id));
      if (candidates.length === 0) {
        return { promoted, destructionPending: 0, oldestPendingDispositionAt: null };
      }
      const held = await tx
        .select({ documentId: HOLD.documentId })
        .from(HOLD)
        .where(
          and(
            inArray(
              HOLD.documentId,
              candidates.map((b) => b.initialDocumentId),
            ),
            isNull(HOLD.releasedAt),
          ),
        );
      const heldDocs = new Set(held.map((h) => h.documentId));
      const pending = candidates.filter((b) => !heldDocs.has(b.initialDocumentId));
      const oldest = pending
        .map((b) => b.dispositionAt)
        .filter((d): d is Date => d instanceof Date)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      return {
        promoted,
        destructionPending: pending.length,
        oldestPendingDispositionAt: oldest ? oldest.toISOString() : null,
      };
    },
  );

  if (outcome.destructionPending > 0 && outcome.oldestPendingDispositionAt) {
    try {
      await deps.onDestructionPending?.({
        organizationId,
        retentionClass: "intake_artifact",
        destructionPending: outcome.destructionPending,
        oldestDispositionAt: outcome.oldestPendingDispositionAt,
      });
    } catch {
      // best-effort: the next daily tick reports the same set again.
    }
  }
  return outcome;
}

export interface RetentionRotationWorkerDeps extends RetentionRotationDeps {
  readonly connection: ConnectionOptions;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly log?: (msg: string, detail: Record<string, unknown>) => void;
}

export async function runRetentionRotationFanout(
  deps: Omit<RetentionRotationWorkerDeps, "connection">,
): Promise<{ orgs: number; promoted: number; destructionPending: number }> {
  const failures: unknown[] = [];
  let orgs = 0;
  let promoted = 0;
  let destructionPending = 0;
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    orgs += 1;
    try {
      const res = await rotateIntakeRetentionForOrg(deps, organizationId);
      promoted += res.promoted;
      destructionPending += res.destructionPending;
      if (res.promoted + res.destructionPending > 0) {
        deps.log?.("m22.retention_rotation.tick", { organizationId, ...res });
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `M22_RETENTION_ROTATION: ${failures.length} org failure(s)`);
  }
  return { orgs, promoted, destructionPending };
}

export function registerRetentionRotationWorker(deps: RetentionRotationWorkerDeps): Worker {
  return new Worker(M22_RETENTION_ROTATION_QUEUE, async () => runRetentionRotationFanout(deps), {
    connection: deps.connection,
    concurrency: 1,
  });
}

export async function scheduleRetentionRotation(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M22_RETENTION_ROTATION_QUEUE, { connection });
  await queue.add(
    "daily",
    {},
    {
      repeat: { pattern: M22_RETENTION_ROTATION_SCHEDULE },
      jobId: "m22-retention-rotation-daily",
      attempts: 2,
      backoff: { type: "exponential", delay: 300_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
