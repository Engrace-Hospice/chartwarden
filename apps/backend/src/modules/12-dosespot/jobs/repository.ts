// apps/backend/src/modules/12-dosespot/jobs/repository.ts — the `dosespot_sync_queue` data port
// (M12 `handlers-unbound` group, #248). Mirrors `packages/quality/src/repositories/recompute-queue.ts`'s
// (F-150, #248) debounced-enqueue + claim shape, adapted to this queue's two-kind vocabulary and its
// `FOR UPDATE SKIP LOCKED` claim (the `outbox-dispatcher.ts` `pollOrgBatch` precedent, so two worker
// ticks racing the same org's pending rows can never claim the same one).
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, sql } from "drizzle-orm";

type DosespotSyncQueueKind = schema.DosespotSyncQueueKind;
type DosespotSyncQueueReason = schema.DosespotSyncQueueReason;
type DosespotSyncQueueRow = schema.DosespotSyncQueueRow;

const Q = schema.dosespotSyncQueue;

export interface EnqueueInput {
  readonly organizationId: string;
  readonly kind: DosespotSyncQueueKind;
  readonly reason: DosespotSyncQueueReason;
  readonly patientId: string;
  /** Required iff `kind === "medhx_fetch"` (the migration's CHECK constraint enforces this at the DB). */
  readonly admissionId?: string;
  readonly invalidateRxBenefitCache?: boolean;
  readonly triggeringEventOutboxId?: string;
}

export interface EnqueueResult {
  readonly row: DosespotSyncQueueRow;
  /** `true` when this call collapsed onto an already-pending row rather than inserting a new one. */
  readonly debounced: boolean;
}

/**
 * `DosespotSyncQueueRepository` — the enqueue/claim/settle surface the outbox consumers and the drain
 * worker share. Every method is a single statement (or two, for the atomic claim), safe to run inside a
 * caller-supplied `withOrgContext` transaction.
 */
export class DosespotSyncQueueRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Enqueue (debounced): insert a pending row, collapsing onto the existing pending row for the same
   * (organization, kind, patient) when one already exists (the partial-unique index). `admissionId` on a
   * debounce hit is NOT overwritten — the first trigger's admission context wins, which is fine: both a
   * fresh `admission_activated` and a later `recertification` MedHx pull for the same still-pending job
   * ask DoseSpot for the same patient's history regardless of which admission named it.
   */
  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const values = {
      organizationId: input.organizationId,
      kind: input.kind,
      reason: input.reason,
      patientId: input.patientId,
      admissionId: input.admissionId ?? null,
      invalidateRxBenefitCache: input.invalidateRxBenefitCache ?? false,
      triggeringEventOutboxId: input.triggeringEventOutboxId ?? null,
    };
    const [inserted] = await this.db
      .insert(Q)
      .values(values)
      .onConflictDoNothing({
        target: [Q.organizationId, Q.kind, Q.patientId],
        where: sql`status = 'pending'`,
      })
      .returning();
    if (inserted) return { row: inserted, debounced: false };

    const [existing] = await this.db
      .select()
      .from(Q)
      .where(
        and(
          eq(Q.organizationId, input.organizationId),
          eq(Q.kind, input.kind),
          eq(Q.patientId, input.patientId),
          eq(Q.status, "pending"),
        ),
      )
      .limit(1);
    if (!existing)
      throw new Error("dosespot_sync_queue enqueue produced neither insert nor a debounce hit");
    return { row: existing, debounced: true };
  }

  /**
   * Atomically claim up to `limit` pending rows for one org, oldest-enqueued first: `SELECT ... FOR
   * UPDATE SKIP LOCKED` picks the ids so two ticks (or two worker processes) racing the same org's queue
   * never claim the same row (`outbox-dispatcher.ts`'s `pollOrgBatch` template), then one bulk `UPDATE`
   * flips them to `processing` and bumps `version`+`claimed_at`. Must run inside the caller's
   * `withOrgContext` transaction — this method issues no tenancy envelope of its own.
   */
  async claimBatchForOrg(
    organizationId: string,
    limit = 25,
    now: Date = new Date(),
  ): Promise<readonly DosespotSyncQueueRow[]> {
    const due = await this.db.execute(sql`
      SELECT id FROM dosespot_sync_queue
      WHERE organization_id = ${organizationId}
        AND status = 'pending'
      ORDER BY enqueued_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    const ids = ((due as unknown as { rows?: Array<{ id: string }> }).rows ?? []).map((r) => r.id);
    if (ids.length === 0) return [];
    return this.db
      .update(Q)
      .set({ status: "processing", claimedAt: now, version: sql`${Q.version} + 1` })
      .where(and(eq(Q.organizationId, organizationId), inArray(Q.id, ids)))
      .returning();
  }

  /** Terminal success: `completed`, stamp `processed_at`. */
  async markCompleted(id: string, now: Date = new Date()): Promise<void> {
    await this.db.update(Q).set({ status: "completed", processedAt: now }).where(eq(Q.id, id));
  }

  /**
   * Terminal (non-retryable) failure: `failed`, bump `attempt_count`, record `last_error`. Used for the
   * `DegradedError(retryable: false)` case — including the current always-unbound vendor client and
   * snapshot resolver — where re-attempting the same row would only reproduce the identical failure.
   */
  async markFailed(id: string, error: string, now: Date = new Date()): Promise<void> {
    await this.db
      .update(Q)
      .set({
        status: "failed",
        attemptCount: sql`${Q.attemptCount} + 1`,
        lastError: error,
        processedAt: now,
      })
      .where(eq(Q.id, id));
  }

  /**
   * Retryable failure: back to `pending` (the next drain tick re-attempts), bump `attempt_count`, record
   * `last_error`. Reachable only once a real vendor client can return `DegradedError(retryable: true)` —
   * unexercised in this environment today, where the deny-stub client always answers `retryable: false`.
   */
  async requeue(id: string, error: string): Promise<void> {
    await this.db
      .update(Q)
      .set({ status: "pending", attemptCount: sql`${Q.attemptCount} + 1`, lastError: error })
      .where(eq(Q.id, id));
  }
}
