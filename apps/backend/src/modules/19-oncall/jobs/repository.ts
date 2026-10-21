// apps/backend/src/modules/19-oncall/jobs/repository.ts — the `on_call_roster_sync_queue` data port
// (m19 `handlers-unbound` group, #248; F-155's own finding, now built). Mirrors
// `apps/backend/src/modules/12-dosespot/jobs/repository.ts`'s (F-162, #248) enqueue/claim/settle shape and
// its `FOR UPDATE SKIP LOCKED` claim (the `outbox-dispatcher.ts` `pollOrgBatch` precedent), with ONE
// deliberate departure: `triggerDebounce` BUMPS `run_after` forward on every call via
// `onConflictDoUpdate`, rather than `onConflictDoNothing`ing onto an already-pending row. See the schema
// file's own header (`packages/db/src/schema/oncall/on-call-roster-sync-queue.ts`) for why a TRUE
// reset-the-delay debounce needs this rather than the dosespot/measure-recompute "collapse onto pending"
// shape.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, sql } from "drizzle-orm";

type OnCallRosterSyncQueueRow = schema.OnCallRosterSyncQueueRow;

const Q = schema.onCallRosterSyncQueue;

export interface TriggerDebounceInput {
  readonly organizationId: string;
  /** The `m17.visit.assigned` outbox event id that triggered this bump. */
  readonly triggeringEventOutboxId: string;
  readonly now?: Date;
  readonly debounceWindowMs: number;
}

export interface EnsureCatchUpPendingInput {
  readonly organizationId: string;
  readonly now?: Date;
}

/**
 * `OnCallRosterSyncQueueRepository` — the enqueue/claim/settle surface the `m17.visit.assigned` outbox
 * consumer, the periodic catch-up worker, and the drain worker share. Every method is a single statement
 * (or two, for the atomic claim), safe to run inside a caller-supplied `withOrgContext` transaction.
 */
export class OnCallRosterSyncQueueRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * The `m17.visit.assigned` trigger path — §4.8 "debounced 30 s". Always writes a row: on first trigger,
   * INSERTs a fresh `pending` row with `run_after = now + window`; on a trigger while one is already
   * `pending` for this org, the partial-unique `(organization_id) WHERE status = 'pending'` conflict is
   * caught by `onConflictDoUpdate`, which BUMPS `run_after` forward to `now + window` again — the reset
   * that makes this a true debounce rather than a mere "at most one pending" dedupe. A trigger arriving
   * while the org's row is `processing` (a drain already claimed it) is NOT a conflict — the partial index
   * only covers `pending` rows — so it correctly inserts a SECOND pending row: the roster the in-flight
   * drain is about to read predates this new assignment, so a follow-up reconciliation is genuinely owed.
   */
  async triggerDebounce(input: TriggerDebounceInput): Promise<OnCallRosterSyncQueueRow> {
    const now = input.now ?? new Date();
    const runAfter = new Date(now.getTime() + input.debounceWindowMs);
    const [row] = await this.db
      .insert(Q)
      .values({
        organizationId: input.organizationId,
        reason: "m17_visit_assigned",
        status: "pending",
        runAfter,
        triggeringEventOutboxId: input.triggeringEventOutboxId,
      })
      .onConflictDoUpdate({
        target: [Q.organizationId],
        targetWhere: sql`status = 'pending'`,
        set: {
          runAfter,
          triggeringEventOutboxId: input.triggeringEventOutboxId,
        },
      })
      .returning();
    if (!row) throw new Error("on_call_roster_sync_queue triggerDebounce produced no row");
    return row;
  }

  /**
   * The periodic §4.5 "shift cron tick" catch-up path. INSERTs a `cron_catchup` row with
   * `run_after = now` ONLY when no pending row already exists for the org — `onConflictDoNothing`, never
   * a bump. An org mid-debounce (a real `m17.visit.assigned` trigger already counting down) is left
   * untouched: the catch-up's whole job is to cover an org NOTHING has recently touched, not to race an
   * event-triggered window.
   */
  async ensureCatchUpPending(
    input: EnsureCatchUpPendingInput,
  ): Promise<{ readonly created: boolean }> {
    const now = input.now ?? new Date();
    const [row] = await this.db
      .insert(Q)
      .values({
        organizationId: input.organizationId,
        reason: "cron_catchup",
        status: "pending",
        runAfter: now,
      })
      .onConflictDoNothing({ target: [Q.organizationId], where: sql`status = 'pending'` })
      .returning();
    return { created: row !== undefined };
  }

  /**
   * Atomically claim ONE due pending row for one org (`SELECT ... FOR UPDATE SKIP LOCKED`, oldest-enqueued
   * first, so two ticks — or two worker processes — racing the same org's queue never claim the same row),
   * then flip it to `processing`. `null` when the org has no row, or its one row's `run_after` has not
   * yet elapsed (the debounce is still counting down). Must run inside the caller's `withOrgContext`
   * transaction — this method issues no tenancy envelope of its own.
   */
  async claimDueForOrg(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<OnCallRosterSyncQueueRow | null> {
    const due = await this.db.execute(sql`
      SELECT id FROM on_call_roster_sync_queue
      WHERE organization_id = ${organizationId}
        AND status = 'pending'
        AND run_after <= ${now}
      ORDER BY enqueued_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const ids = ((due as unknown as { rows?: Array<{ id: string }> }).rows ?? []).map((r) => r.id);
    if (ids.length === 0) return null;
    const [claimed] = await this.db
      .update(Q)
      .set({ status: "processing", claimedAt: now, version: sql`${Q.version} + 1` })
      .where(and(eq(Q.organizationId, organizationId), eq(Q.id, ids[0] as string)))
      .returning();
    return claimed ?? null;
  }

  /** Terminal success: `completed`, stamp `processed_at`. */
  async markCompleted(id: string, now: Date = new Date()): Promise<void> {
    await this.db.update(Q).set({ status: "completed", processedAt: now }).where(eq(Q.id, id));
  }

  /** Terminal (non-retryable) failure: `failed`, bump `attempt_count`, record `last_error`. */
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
}
