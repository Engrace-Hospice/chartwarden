// @wardenx/quality · repositories — the debounced measure-recompute work list:
// `measure_recompute_queue` (one PENDING row per (measure, provider_entity, period) — a triggering
// domain event / cron flips `requires_recompute=true`; the recompute worker clears it) (M30 §3.3).
// ORG-SCOPED; the outbox consumer that enqueues + the worker that drains wrap these in `withOrgContext`.
// The V `uq_measure_recompute_pending` partial-unique (WHERE requires_recompute=true) collapses repeated
// triggers into the one pending row (debounce).
import { schema } from "@wardenx/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { QualityDb } from "./db";

const Q = schema.measureRecomputeQueue;

/** Data port for `measure_recompute_queue`. */
export class MeasureRecomputeQueueRepository {
  constructor(private readonly db: QualityDb) {}

  /**
   * Enqueue (debounced): insert a pending row, but collapse onto the existing one when a pending row
   * for the same (measure, provider_entity, period) already exists (the V partial-unique). Returns the
   * pending row either way (the freshly-inserted one, or the pre-existing one on a debounce hit).
   */
  async enqueue(values: schema.NewMeasureRecomputeQueue): Promise<schema.MeasureRecomputeQueue> {
    const [inserted] = await this.db
      .insert(Q)
      .values(values)
      .onConflictDoNothing({
        target: [Q.measureCode, Q.providerEntityId, Q.periodStart, Q.periodEnd],
        where: sql`requires_recompute = true`,
      })
      .returning();
    if (inserted) return inserted;
    // Debounce hit: the pending row already exists — return it.
    const existing = await this.findPending(
      values.measureCode,
      values.providerEntityId,
      values.periodStart,
      values.periodEnd,
    );
    if (!existing) throw new Error("measure_recompute_queue enqueue produced neither insert nor hit");
    return existing;
  }

  /** The pending row for a (measure, provider_entity, period) (`requires_recompute=true`), or `null`. */
  async findPending(
    measureCode: string,
    providerEntityId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<schema.MeasureRecomputeQueue | null> {
    const [row] = await this.db
      .select()
      .from(Q)
      .where(
        and(
          eq(Q.measureCode, measureCode),
          eq(Q.providerEntityId, providerEntityId),
          eq(Q.periodStart, periodStart),
          eq(Q.periodEnd, periodEnd),
          eq(Q.requiresRecompute, true),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The worker's drain scan: pending rows (optionally scoped to one org), oldest-enqueued first. */
  async listPending(
    opts: { organizationId?: string; limit?: number } = {},
  ): Promise<readonly schema.MeasureRecomputeQueue[]> {
    const where = and(
      eq(Q.requiresRecompute, true),
      opts.organizationId ? eq(Q.organizationId, opts.organizationId) : undefined,
    );
    return this.db
      .select()
      .from(Q)
      .where(where)
      .orderBy(asc(Q.enqueuedAt))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  }

  /** Clear a row after a successful recompute (`requires_recompute=false`, stamp `processed_at`). */
  async markProcessed(
    id: string,
    processedAt: Date = new Date(),
  ): Promise<schema.MeasureRecomputeQueue> {
    const [row] = await this.db
      .update(Q)
      .set({ requiresRecompute: false, processedAt })
      .where(eq(Q.id, id))
      .returning();
    if (!row) throw new Error(`measure_recompute_queue ${id} not found for markProcessed`);
    return row;
  }

  /** Bump a row's attempt counter after a failed recompute (drives the worker's backoff). */
  async incrementAttempt(id: string): Promise<schema.MeasureRecomputeQueue> {
    const [row] = await this.db
      .update(Q)
      .set({ attemptCount: sql`${Q.attemptCount} + 1` })
      .where(eq(Q.id, id))
      .returning();
    if (!row) throw new Error(`measure_recompute_queue ${id} not found for incrementAttempt`);
    return row;
  }
}
